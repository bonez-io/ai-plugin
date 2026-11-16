#!/usr/bin/env python3
"""Inspect the upload ZIP itself. Run with: uv run --no-project --with pyyaml --with pillow python <script> <zip>.

Exit 0 means these local package checks passed, not that OpenAI approved the plugin.
--require-review-materials also fails on missing review/publication fields.
Network, OAuth, reviewer access, tool annotations and portal scans require separate checks.
"""
import argparse
import io
import json
import re
import stat
import zipfile
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import yaml
from PIL import Image

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("archive")
parser.add_argument("--require-review-materials", action="store_true")
args = parser.parse_args()
errors, gaps = [], []


def check(condition, message):
    if not condition:
        errors.append(message)


def https(value):
    if not isinstance(value, str) or len(value) > 1024:
        return False
    parsed = urlsplit(value)
    return parsed.scheme == "https" and bool(parsed.hostname) and not parsed.username and not parsed.password


with zipfile.ZipFile(args.archive) as archive:
    inventory = archive.infolist()
    names = [item.filename for item in inventory]
    check(len(names) == len(set(names)), "duplicate ZIP entries")
    for item in inventory:
        p = PurePosixPath(item.filename)
        check(not p.is_absolute() and ".." not in p.parts and "\\" not in item.filename, f"unsafe path: {item.filename}")
        check(not stat.S_ISLNK(item.external_attr >> 16), f"symlink: {item.filename}")
    check("bonez/plugin.json" in names, "expected one enclosing bonez/ directory")
    check(all(n.startswith("bonez/") for n in names), "unrelated archive siblings")
    files = {n.removeprefix("bonez/"): archive.read(n) for n in names if not n.endswith("/")}
    forbidden = {"hooks", ".app.json", ".git", "node_modules", ".DS_Store", "marketplace.json", ".mcp.json"}
    for name in files:
        check(not set(PurePosixPath(name).parts) & forbidden, f"unsupported public-upload file: {name}")
        check(not name.startswith(("bin/", "commands/", "scripts/")), f"unexpected local component: {name}")
        if name.endswith(".json"):
            json.loads(files[name])
    manifest = json.loads(files["plugin.json"])
    check(manifest.get("$schema") == "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", "manifest schema")
    check(manifest.get("name") == "bonez", "plugin identity must remain bonez")
    check(bool(re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", manifest.get("version", ""))), "semantic version")
    check(not set(manifest) & {"skills", "mcpServers", "interface", "apps"}, "legacy fields in portable manifest")
    openai = manifest["extensions"]["com.openai"]
    check(openai.get("apps") is None and "hooks" not in openai, "app references or lifecycle hooks")
    for name, data in files.items():
        if name.endswith("plugin.json"):
            other = json.loads(data)
            check(other.get("apps") is None and other.get("extensions", {}).get("com.openai", {}).get("apps") is None, f"app binding in {name}")
    listing = openai["interface"]
    for field, maximum in {"displayName": 30, "shortDescription": 30, "longDescription": 4000}.items():
        value = listing.get(field)
        check(isinstance(value, str) and bool(value.strip()) and len(value) <= maximum, f"invalid {field}")
    categories = {"Business & Operations", "Communication", "Creativity", "Data & Analytics", "Developer Tools", "Education & Research", "Entertainment", "Finance", "Healthcare", "Other", "Productivity", "Scientific Research", "Security", "Travel"}
    check(listing.get("category") in categories, "unsupported category")
    for field in ("websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"):
        check(https(listing.get(field)), f"invalid or missing {field}")
    prompts = listing["defaultPrompt"]
    prompts = [prompts] if isinstance(prompts, str) else prompts
    check(1 <= len(prompts) <= 3, "default prompt count")
    check(all(isinstance(p, str) and p.strip() and len(p) <= 128 and "\n" not in p and "@" not in p for p in prompts), "invalid default prompt")
    check(len({" ".join(p.split()) for p in prompts}) == len(prompts), "duplicate prompts")
    for field, minimum in (("logo", 256), ("composerIcon", 48)):
        name = listing.get(field, "").removeprefix("./")
        check(name in files, f"missing {field} file")
        if name in files:
            with Image.open(io.BytesIO(files[name])) as icon:
                check(icon.format == "PNG" and icon.width == icon.height and minimum <= icon.width <= 4096, f"invalid {field} format or dimensions")
                icon.verify()
            check(len(files[name]) <= 5 * 1024 * 1024, f"oversize {field}")
    skills = [n for n in files if re.fullmatch(r"skills/[^/]+/SKILL.md", n)]
    check(len(skills) == 11, "expected all eleven remote directory workflows")
    seen = set()
    for name in skills:
        text = files[name].decode("utf-8")
        check(len(files[name]) <= 1024 * 1024, f"oversize skill {name}")
        match = re.match(r"\A---\n(.*?)\n---(?:\n|$)", text, re.S)
        check(bool(match), f"missing frontmatter {name}")
        if not match:
            continue
        frontmatter = yaml.safe_load(match[1])
        skill_name = frontmatter.get("name")
        check(skill_name == PurePosixPath(name).parts[1] and skill_name not in seen, f"invalid or duplicate skill name: {name}")
        check(isinstance(frontmatter.get("description"), str) and bool(frontmatter["description"].strip()), f"invalid description: {name}")
        seen.add(skill_name)
        check(not re.search(r"CLAUDE_PLUGIN_ROOT|bonez-plugin-push|session-sync|\bBONEZ_", text), f"missing local runtime dependency: {name}")
    for name, data in files.items():
        if name.startswith("skills/") and name.endswith(".md"):
            check(not re.search(r"\bvendor_(search|info|read|write)\b", data.decode("utf-8")), f"unsupported generic tool in {name}")
    remembering = files["skills/remembering/SKILL.md"].decode("utf-8")
    check('After every successful write, fetch the returned memory ID' in remembering, "memory writes need readback")
    check('Save only when the user requests or authorizes it' in remembering, "memory writes need user authorization")
    check('"kind": "convention"' not in remembering and '`kind: context`' not in remembering, "outdated memory kinds")
    mcp = json.loads(files["mcp.json"])
    check(mcp.get("$schema") == "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", "MCP schema")
    check(set(mcp["mcpServers"]) == {"bonez"}, "one intended server")
    server = mcp["mcpServers"]["bonez"]
    check(server.get("type") == "streamable-http" and server.get("url") == "https://gateway.bonez.io/mcp?profile=directory", "MCP endpoint/transport")
    check("headers" not in server, "Platform app setup does not accept custom MCP headers")
    auth = server["extensions"]["com.openai"]["auth"]
    check(auth.get("type") == "oauth" and set(auth.get("baseScopes", [])) == {"bonez:read", "bonez:memory", "bonez:write"}, "OAuth method/scopes")
    check(not set(server) & {"oauth", "scopes", "tools", "http_headers"}, "local-only MCP settings")
    check(auth.get("client") == {"mode": "dcr"}, "Use Auth0 dynamic registration, not the default CIMD client")
    check("clientSecret" not in auth, "OAuth secret must not be packaged")
    review = openai["review"]
    check(0 < len(review["prompts"]) <= 20 and all(isinstance(p, str) and p.strip() and len(p) <= 4000 for p in review["prompts"]), "invalid review prompts")
    cases = review["test_cases"]
    for kind, minimum in (("positive", 5), ("negative", 3)):
        check(len(cases[kind]) >= minimum, f"insufficient {kind} cases")
        for case in cases[kind]:
            required = ["description", "prompt"] + (["tools_triggered", "expected_behavior"] if kind == "positive" else [])
            check(all(isinstance(case.get(k), str) and case[k].strip() for k in required), f"incomplete {kind} case")
    if not listing.get("developerName"):
        gaps.append("Confirm and set the intended verified publisher name.")
    if "countries" not in openai["publication"]:
        gaps.append("Confirm country availability (explicit [] means all countries).")
    if not isinstance(review.get("commerce"), bool):
        gaps.append("Confirm commerce behavior and, if applicable, what is purchased and where.")
    if not https(review.get("demo_recording_url")):
        gaps.append("Record the demo, verify reviewer-accessible playback, and set demo_recording_url.")
    check(bool(openai["publication"].get("release_notes")), "release notes missing")

print(json.dumps({"archive": args.archive, "files": len(files), "skills": len(skills), "version": manifest["version"], "package_checks": "failed" if errors else "passed", "errors": errors, "preparation_gaps": gaps, "portal_checks": "Not run: OAuth connection, live annotations, test cases, reviewer access, domain/developer verification, scans and attestations."}, indent=2))
raise SystemExit(1 if errors or (args.require_review_materials and gaps) else 0)
