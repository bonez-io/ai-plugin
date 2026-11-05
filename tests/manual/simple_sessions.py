"""Live paired CLI benchmark. Requires a running Bonez dev cluster and signed-in clients."""

import argparse
import concurrent.futures
import http.client
import json
import os
import secrets
import shutil
import statistics
import subprocess
import tempfile
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

REPO = Path(__file__).resolve().parents[2]
PROMPTS = [
    ("arithmetic", "What is 17 + 25? Reply with just the number.", "42"),
    ("rewrite", "Uppercase the word saffron. Reply with just the word.", "SAFFRON"),
    (
        "path",
        "What is the filename extension of src/example.py? Reply with just the two letters.",
        "py",
    ),
]


def admin(url, token, method, body=None):
    req = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.loads(response.read() or b"{}")


def proxy(upstream, key, local_token, calls):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            if self.path != "/mcp":
                self.send_error(404)
                return
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            msg = json.loads(raw)
            rpc = msg.get("method", "")
            target = msg.get("params", {}).get("name") if rpc == "tools/call" else rpc
            if (
                rpc == "tools/call"
                and self.headers.get("Authorization") != "Bearer " + local_token
            ):
                self.send_error(401)
                return
            start = time.monotonic()
            conn = http.client.HTTPConnection(
                upstream.hostname, upstream.port, timeout=15
            )
            try:
                headers = {
                    k: v
                    for k, v in self.headers.items()
                    if k.lower() not in ("host", "authorization")
                }
                headers["Authorization"] = "Bearer " + key
                conn.request("POST", "/mcp", raw, headers)
                response = conn.getresponse()
                data = response.read()
                calls.append(
                    {
                        "method": rpc,
                        "name": target,
                        "status": response.status,
                        "ms": round((time.monotonic() - start) * 1000),
                    }
                )
                self.send_response(response.status)
                for h, v in response.getheaders():
                    if h.lower() not in (
                        "connection",
                        "transfer-encoding",
                        "content-length",
                    ):
                        self.send_header(h, v)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            finally:
                conn.close()

    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def trust(home, work, env):
    proc = subprocess.Popen(
        ["codex", "app-server"],
        cwd=work,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )

    def request(i, method, params):
        proc.stdin.write(
            json.dumps({"id": i, "method": method, "params": params}) + "\n"
        )
        proc.stdin.flush()
        for line in proc.stdout:
            reply = json.loads(line)
            if reply.get("id") == i:
                return reply["result"]
        raise RuntimeError("Codex app-server closed")

    try:
        request(
            1,
            "initialize",
            {
                "clientInfo": {"name": "bonez_benchmark", "version": "1"},
                "capabilities": {"experimentalApi": True},
            },
        )
        proc.stdin.write('{"method":"initialized"}\n')
        hooks = request(2, "hooks/list", {"cwds": [str(work)]})["data"][0]["hooks"]
        with (home / "config.toml").open("a") as f:
            for h in hooks:
                if h["pluginId"] == "bonez@bonez":
                    decl, content = h["currentHash"].split("/")
                    f.write(
                        f'\n[hooks.state.{json.dumps(h["key"])}]\ntrusted_hash="{decl}"\ntrusted_content_hash="{content}"\n'
                    )
    finally:
        proc.terminate()
        proc.wait()


def setup(client, root, on, url, local_token):
    root.mkdir()
    work = root / "work"
    work.mkdir()
    home = root / "profile"
    home.mkdir()
    env = dict(
        os.environ,
        BONEZ_SESSION_SYNC="0",
        BONEZ_GATEWAY_URL=url,
        CLAUDE_PLUGIN_OPTION_BONEZ_URL=url,
    )
    if on:
        pkg = root / "market"
        pkg.mkdir()
        paths = (
            ["codex", ".agents"]
            if client == "codex"
            else ["bin", "hooks", "skills", "commands", ".claude-plugin", ".mcp.json"]
        )
        for part in paths:
            src = REPO / part
            (shutil.copytree if src.is_dir() else shutil.copyfile)(src, pkg / part)
        manifest = (pkg / "codex" if client == "codex" else pkg) / ".mcp.json"
        cfg = json.loads(manifest.read_text())
        server = cfg["mcpServers"]["bonez"]
        server["url"] = url + "/mcp"
        # Only a dummy goes to the loopback recorder; it owns the local scoped key.
        if client == "codex":
            server["bearer_token_env_var"] = "BONEZ_BENCH_TOKEN"
        else:
            server["headers"]["Authorization"] = "Bearer " + local_token
            manifest_plugin = pkg / ".claude-plugin/plugin.json"
            plugin_cfg = json.loads(manifest_plugin.read_text())
            plugin_cfg["userConfig"]["bonez_url"]["default"] = url
            manifest_plugin.write_text(json.dumps(plugin_cfg))
        manifest.write_text(json.dumps(cfg))
    if client == "codex":
        auth = Path(env.get("CODEX_HOME", Path.home() / ".codex")) / "auth.json"
        (home / "auth.json").symlink_to(auth)
        env.update(CODEX_HOME=str(home), BONEZ_BENCH_TOKEN=local_token)
        if on:
            for args in (["marketplace", "add", str(pkg)], ["add", "bonez@bonez"]):
                subprocess.run(
                    ["codex", "plugin", *args],
                    cwd=work,
                    env=env,
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
            trust(home, work, env)
        cmd = [
            "codex",
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "-s",
            "read-only",
            "-c",
            'model_reasoning_effort="low"',
            "--json",
        ]
    else:
        env.update(CLAUDE_CONFIG_DIR=str(home))
        if env.get("OPENROUTER_API_KEY"):
            env.update(
                ANTHROPIC_API_KEY="",
                ANTHROPIC_AUTH_TOKEN=env["OPENROUTER_API_KEY"],
                ANTHROPIC_BASE_URL="https://openrouter.ai/api",
                ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/claude-sonnet-4.6",
                ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/claude-haiku-4.5",
            )
        cmd = [
            "claude",
            "-p",
            "--setting-sources",
            "",
            "--no-session-persistence",
            "--model",
            "sonnet",
            "--verbose",
            "--output-format",
            "stream-json",
        ]
        if on:
            cmd += ["--plugin-dir", str(pkg)]
        cmd += ["--"]
    return env, work, cmd


def turn(client, setup_data, prompt):
    env, work, cmd = setup_data
    start = time.monotonic()
    first = None
    answer = ""
    tools = []
    errors = []
    tokens = None
    proc = subprocess.Popen(
        [*cmd, prompt],
        cwd=work,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    timer = threading.Timer(100, proc.kill)
    timer.start()
    try:
        for line in proc.stdout:
            e = json.loads(line)
            if client == "claude":
                if e["type"] == "assistant":
                    for b in e["message"]["content"]:
                        if b["type"] == "tool_use":
                            tools.append(b["name"])
                        if b["type"] == "text":
                            answer = b["text"]
                if (
                    e.get("subtype") == "permission_denied"
                    or e.get("outcome") == "error"
                ):
                    errors.append(e.get("subtype"))
                if e["type"] == "result":
                    errors += [
                        d.get("tool_name", "denied")
                        for d in e.get("permission_denials", [])
                    ]
                    answer = e.get("result", "")
                    tokens = e.get("usage")
            else:
                i = e.get("item", {})
                if e["type"] == "item.completed":
                    if i.get("type") == "agent_message":
                        answer = i["text"]
                    else:
                        tools.append(i.get("tool", i.get("type")))
                    if i.get("status") == "failed":
                        errors.append(i.get("tool", i["type"]))
                if e["type"] == "turn.completed":
                    tokens = e.get("usage")
            if answer and first is None:
                first = round((time.monotonic() - start) * 1000)
        code = proc.wait()
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
    return {
        "first_ms": first,
        "total_ms": round((time.monotonic() - start) * 1000),
        "answer": answer.strip(),
        "tools": tools,
        "errors": errors,
        "exit": code,
        "usage": tokens,
    }


def bench(client, pairs, target, key, out, scenario):
    calls = []
    local_token = secrets.token_urlsafe(32)
    srv = proxy(target, key, local_token, calls)
    url = f"http://127.0.0.1:{srv.server_port}"
    try:
        with (
            tempfile.TemporaryDirectory() as scratch,
            (out / (client + ".jsonl")).open("w") as f,
        ):
            profiles = {
                on: setup(client, Path(scratch) / str(on), on, url, local_token)
                for on in (False, True)
            }
            prompts = PROMPTS
            if scenario == "file-read":
                word = "kite-" + secrets.token_hex(3)
                for _, work, _ in profiles.values():
                    (work / "note.txt").write_text(word + "\n", encoding="utf-8")
                prompts = [
                    (
                        "file-read",
                        "Read note.txt and reply with just its first line.",
                        word,
                    )
                ]
            for pair in range(-1, pairs):
                kind, prompt, expected = prompts[max(0, pair) % len(prompts)]
                for on in (False, True) if pair % 2 == 0 else (True, False):
                    calls.clear()
                    r = turn(client, profiles[on], prompt)
                    r.update(
                        client=client,
                        pair=pair,
                        plugin=on,
                        task=kind,
                        correct=r["answer"] == expected,
                        rpc=list(calls),
                    )
                    print(json.dumps(r), file=f, flush=True)
                    print(
                        client,
                        pair,
                        on,
                        kind,
                        r["first_ms"],
                        r["correct"],
                        r["tools"],
                        [c["name"] for c in calls if c["method"] == "tools/call"],
                        flush=True,
                    )
    finally:
        srv.shutdown()
        srv.server_close()


def report(out):
    """Summarize complete pairs, separating gateway discovery from memory tool calls."""
    summary = {}
    passed = True
    for path in sorted(out.glob("*.jsonl")):
        rows = [
            r
            for line in path.read_text().splitlines()
            if (r := json.loads(line))["pair"] >= 0
        ]
        arms = {
            on: sorted((r for r in rows if r["plugin"] == on), key=lambda r: r["pair"])
            for on in (False, True)
        }
        off, on = arms[False], arms[True]
        if not off or [r["pair"] for r in off] != [r["pair"] for r in on]:
            raise RuntimeError("Incomplete pairs in " + path.name)
        memory_calls = [c for r in on for c in r["rpc"] if c["method"] == "tools/call"]
        discovery = sum(
            any(c["method"] == "tools/list" and c["status"] == 200 for c in r["rpc"])
            for r in on
        )
        errors = sum(bool(r["errors"] or r["exit"] or not r["correct"]) for r in rows)
        unexpected = sum(bool(r["tools"]) for r in on if r["task"] != "file-read")
        metrics = {}
        for key in ("first_ms", "total_ms"):
            if all(isinstance(r[key], int) for r in rows):
                metrics[key] = {
                    "off_median": statistics.median(r[key] for r in off),
                    "on_median": statistics.median(r[key] for r in on),
                    "paired_median_delta": statistics.median(
                        b[key] - a[key] for a, b in zip(off, on)
                    ),
                }
        summary[path.stem] = {
            "pairs": len(off),
            "timings": metrics,
            "tool_calls": len(memory_calls),
            "on_sessions_with_discovery": discovery,
            "failed_sessions": errors,
            "standalone_turns_with_model_tools": unexpected,
        }
        passed &= (
            not errors and not memory_calls and not unexpected and discovery == len(on)
        )
    rendered = json.dumps(summary, indent=2)
    print(rendered)
    (out / "summary.json").write_text(rendered + "\n")
    return passed


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--cluster-cli", required=True)
    p.add_argument("--cluster", default="memory-handoff")
    p.add_argument("--pairs", type=int, default=12)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--client", choices=["both", "claude", "codex"], default="both")
    p.add_argument(
        "--scenario", choices=["standalone", "file-read"], default="standalone"
    )
    args = p.parse_args()
    if args.pairs < 1:
        p.error("--pairs must be positive")
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=False)

    def cluster(*cmd):
        return subprocess.check_output(
            [args.cluster_cli, *cmd, "--name", args.cluster], text=True
        ).strip()

    gateway = json.loads(cluster("env", "--json"))["urls"]["gateway"]
    target = urlsplit(gateway)
    if target.scheme != "http" or target.hostname != "127.0.0.1":
        raise ValueError("Local dev cluster required")
    endpoint = gateway + "/api/admin/api-keys"
    token = cluster("token").splitlines()[-1]
    minted = admin(
        endpoint,
        token,
        "POST",
        {"name": "local simple-session measurement", "scope": "read+memory"},
    )
    try:
        with concurrent.futures.ThreadPoolExecutor() as pool:
            jobs = [
                pool.submit(
                    bench, c, args.pairs, target, minted["key"], args.out, args.scenario
                )
                for c in (
                    ["claude", "codex"] if args.client == "both" else [args.client]
                )
            ]
            for job in jobs:
                job.result()
    finally:
        admin(endpoint + "/" + minted["id"], token, "DELETE")

    if not report(args.out):
        raise SystemExit(
            "Inspect unexpected calls, missing plugin connections or failed sessions."
        )
