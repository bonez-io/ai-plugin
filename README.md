# bonez ai-plugin

The official [bonez](https://bonez.io) plugin for AI coding tools — your organization's **context lake** delivered into whatever coding agent you already use, over MCP.

Bonez indexes your org's repos, tickets, PRs, docs, conversations, and people into one knowledge graph, plus the durable memories its agents accumulate. This plugin connects that graph to your harness and teaches your agent how to use it well.

## Install

### Claude Code (recommended)

The repo is its own marketplace:

```bash
claude plugin marketplace add bonez-io/ai-plugin
claude plugin install bonez@bonez
```

That's it — no key to mint, no env var to set. The bundled `.mcp.json` ships with no
`Authorization` header, so the first call gets a 401 and Claude Code walks you through
OAuth in the browser automatically. You need to be a member of an org that's already
onboarded to bonez; sign in there.

To run that flow yourself instead of waiting for the first tool call (Claude Code
v2.1.186+):

```bash
claude mcp login bonez
```

That opens a browser, you authorize, and `/mcp` shows `bonez` connected.

### OpenAI Codex

MCP config in Codex lives in `~/.codex/config.toml`, shared by Codex CLI, the
IDE extension, and the desktop app — no separate GUI "add server" flow is
documented beyond that shared file, so config.toml (directly or via the CLI)
is the one path in:

```bash
codex mcp add bonez --url https://gateway.bonez.io/mcp
codex mcp login bonez   # run OAuth now instead of waiting for a 401
```

Or paste [`codex/config.toml`](codex/config.toml) into `~/.codex/config.toml`
yourself — same OAuth-by-default install as Claude Code (`auth` defaults to
`"oauth"` for a streamable-HTTP server with no bearer token configured).

Guidance ports:

- [`codex/AGENTS.md`](codex/AGENTS.md) — the 8 skills compressed into
  always-in-context guidance. Copy to `~/.codex/AGENTS.md` (global) or
  `<repo>/AGENTS.md` (one repo); Codex concatenates whichever it finds up the
  directory tree.
- [`codex/skills/`](codex/skills/) — the same 8 skills, ported ~verbatim,
  because Codex turns out to support the same on-demand `SKILL.md` format
  Claude Code does. Copy the directory to `~/.agents/skills/` (user-wide) or
  `<repo>/.agents/skills/` (checked into a repo) — **not** `~/.codex/skills`,
  a common but wrong guess. AGENTS.md above is the belt; these are the
  suspenders, loaded on demand instead of always in context.
- [`codex/prompts/`](codex/prompts/) — `/prompts:context` and
  `/prompts:search`, ported from `commands/`. Copy to `~/.codex/prompts/`
  (top-level `.md` files only). Upstream marks custom prompts deprecated in
  favor of skills; included anyway since they still work today.

**Write-gate gap.** Claude Code's `hooks/gate-write.sh` pauses for
interactive approval before every `rules`/`memory` write, because rules bind
every future session in the org. Codex has no equivalent: its `PreToolUse`
hook can only unconditionally allow or deny a call — `permissionDecision:
"ask"` is parsed but explicitly unimplemented upstream, and Codex fails open
(marks the hook run failed, lets the call through) rather than blocking. The
closest native substitute is `approval_mode = "approve"` on the MCP server's
`memory`/`rules` tools in `config.toml` (commented out in
[`codex/config.toml`](codex/config.toml)), but that prompts for *every* call
including harmless `recall`/`list`/`get`, not just writes. **Writes are
unguarded by default on the Codex leg — there is no bundled equivalent of
the Claude Code gate.**

### Headless / CI: API key instead

OAuth needs a browser, so CI runners, remote boxes, and other headless contexts still use
a personal API key. This lane isn't going away — it's just no longer the default. Mint one
in [console.bonez.io](https://console.bonez.io) under **API keys**, then add the header
yourself (the shipped `.mcp.json` deliberately omits it — Claude Code will not fall back to
OAuth once *any* `Authorization` header is configured, even one that resolves empty):

```bash
export BONEZ_API_KEY=bnz_...
claude mcp add --transport http bonez "${BONEZ_MCP_URL:-https://gateway.bonez.io/mcp}" \
  --header "Authorization: Bearer ${BONEZ_API_KEY}"
```

### Raw MCP (any client, no plugin)

Any MCP client that speaks OAuth discovery: point it at the streamable-HTTP endpoint
`https://gateway.bonez.io/mcp` with no `Authorization` header and let it 401 into the
browser flow. Clients that don't: same endpoint, `Authorization: Bearer <key>` header.

```bash
claude mcp add --transport http bonez https://gateway.bonez.io/mcp --header "Authorization: Bearer <key>"
```

### Environment

| Variable | Purpose |
| --- | --- |
| `BONEZ_API_KEY` | Personal bonez API key (`bnz_…`), minted in console.bonez.io. Optional — only needed for the headless/CI key lane; the default install authenticates via OAuth instead. |
| `BONEZ_MCP_URL` | Override the MCP endpoint — qa (`https://qa.gateway.bonez.io/mcp`) or a local gateway. Defaults to prod. |
| `BONEZ_MCP_GATE_DISABLE` | Set to `1` to disable the memory/rules write permission prompts (headless/CI runs). |
| `BONEZ_SESSION_SYNC` | Set to `0` to disable [session capture](#session-capture) without uninstalling. |
| `BONEZ_GATEWAY_URL` | Override the gateway session capture uploads to — qa or a local gateway. Falls back to `BONEZ_MCP_URL` with `/mcp` stripped, then `https://gateway.bonez.io`. |

### API key scopes

`read` / `read+memory` / `read+write` are nested tiers for the MCP tool surface (`/mcp`).
`sessions` is a separate, disjoint lane for the [session capture](#session-capture) uploader's
two calls (`/api/import/presign`, `/api/import/{id}/complete`) — it never reaches `/mcp`, and an
MCP-scoped key never reaches the import routes. Mint the smallest one that covers what you need:

| Scope | Unlocks |
| --- | --- |
| `read` | Everything read-only: `search`, `schema`, `query`, `fetch`, `context`, plus `memory` recall and `rules` list/get. |
| `read+memory` | `read`, plus `memory` save/update/delete. |
| `read+write` | Everything: `read+memory`, plus `rules` save/update/delete. Rules bind every session in the org — hand these keys out deliberately. |
| `sessions` | Only `bonez-session-sync.mjs install` needs this. Reaches the session-import routes and nothing else — not `/mcp`, not the console. |

## The tools

Seven tools, one loop: **`search` → `schema` → `query` → `fetch`**.

| Tool | What it does |
| --- | --- |
| `search` | Fused org search by intent — code, knowledge, memories, tickets, PRs, docs, people — one ranked call. |
| `schema` | The graph's live ontology: node types, edges, coverage. Call it before guessing shapes. |
| `query` | The BGQ executor — graph traversals over the whole indexed org (callers, blast radius, tests-for, and anything else the grammar reaches). |
| `fetch` | Dereference anything — `~handle`, vendor URL, urn, or `repo_id/path[:line]` — into the full record with provenance and temporal status. |
| `context` | The mount: the same org identity, knowledge, rules, and memory bands bonez's own first-party agents boot with. |
| `memory` | The pen: `recall` freely; `save`/`update`/`delete` durable facts back into the lake (gated behind a permission prompt by this plugin). |
| `rules` | The rulebook: `list`/`get` the org's standing rules and slash commands freely; `save`/`update`/`delete` change binding guidance mounted into every session — write conservatively (prompt-gated by this plugin; needs a `read+write` key). |

## Skills

Judgment for using the lake well — traps, defaults, when to stop:

- **session-context** — mount `context` at task start; what the bands mean.
- **finding-prior-art** — search→fetch before building; coverage gaps and why absence proves nothing.
- **querying-the-graph** — the loop; never guess node types or edges.
- **impact-analysis** — callers / blast radius / tests-for recipes and their depth traps.
- **remembering** — the memory policy: when, when not, never store.
- **citing-bonez-sources** — handles vs vendor URLs; never fabricate a handle.
- **who-owns-what** — people and ownership via the graph, not commit counts.
- **reviewing-with-org-rules** — pull the org's standing rules before reviewing.

Plus two commands: `/bonez:context` and `/bonez:search <query>`.

## Session capture

Your Claude Code and Codex conversations already hold everything the harness itself learns from
— what you tried, what broke, what you decided. This plugin can capture them into the same
`bonez` knowledge graph the desktop app's manual "Import history" feature feeds, so the org
learns from them too. It is **off by default** and stays off until you explicitly install it.

**What it does:** at the end of a matching session (Claude Code's `SessionEnd`; Codex's
`SessionEnd`, plus its `SessionStart` as a durable fallback for sessions that crashed or hit
Codex's tight `SessionEnd` timeout before it could fire), a hook hands the transcript to
`bin/bonez-session-sync.mjs`, which detaches to a background process immediately — the hook
itself never makes a network call and is invisible either way: it never prints anything and
never fails the harness's hook check. The background process parses and scrubs the transcript
on-device (secrets — API keys, tokens, private keys, passwords, connection strings — are masked
*before* anything leaves the machine), then uploads one conversation through the same
presign → PUT → complete pipeline the desktop importer uses. v1 captures conversations only —
not `CLAUDE.md`, auto-memories, commands, or subagents (those change on a different cadence; a
separate follow-up).

**Install (once per machine):**

```bash
bonez-session-sync.mjs login --repo /path/to/repo   # repeat --repo for more
bonez-session-sync.mjs login --global               # every repo on this machine
```

That opens a browser, you sign in the same way you did for the MCP server itself — GitHub,
Google, or any other bonez login — and approve. Nothing to mint, nothing to paste.

The uploader runs its **own** OAuth rather than borrowing the one your coding agent holds,
because it has to: the hook is a separate OS process with no access to the MCP client's
keychain, and that client's token is pinned to `POST /mcp` anyway. So it does the device
flow (RFC 8628), which exists precisely for the case where the program asking for a token
isn't the one the human authorizes in. The token it gets is scoped to `bonez:sessions` —
upload-only. The gateway refuses it on `/mcp`, so this credential cannot read the lake even
though it sits on your disk.

Run from inside a Claude Code session with this plugin enabled, `bin/` is on the Bash tool's
`PATH`, so the bare command above works; otherwise invoke it by its full path (`node
<plugin-root>/bin/bonez-session-sync.mjs login ...`). With no `--repo` given, `login` scopes
capture to whatever directory you ran it from, and prints exactly what uploads, where it
goes, and who can read it before anything is captured.

**Headless / CI**, where there's no browser to sign in with: mint a sessions-scoped key in
[console.bonez.io](https://console.bonez.io) under **API keys** (scope = *Session capture*)
and use `install` instead. Same two-lane shape as the MCP server itself.

```bash
bonez-session-sync.mjs install bnz_... --global
```

| Command | Does |
| --- | --- |
| `login [--repo <path>]... [--global]` | Browser sign-in, then turn capture on. Repo-scoped by default; `--global` captures every repo on this machine. Also re-authorizes an existing install. |
| `logout` | Discard the credential and stop capture. |
| `install <bnz_...key> [--repo <path>]... [--global]` | The headless lane: store a sessions-scoped key (mode 600) and turn capture on. Same scope options. |
| `status` | Enabled/disabled, which credential, scope, repos, sessions synced so far. Never prints a key or token. |
| `disable` / `enable` | Turn capture off/on without discarding the credential. |

Kill switch: `BONEZ_SESSION_SYNC=0` disables capture without touching the installed
config — the same escape hatch `BONEZ_MCP_GATE_DISABLE` gives the write gate.

**Codex leg:** hooks are opt-in per Codex install (`[features] hooks = true` in `config.toml`,
off by default) on top of this plugin's own `install` gate — see the commented-out block in
[`codex/config.toml`](codex/config.toml), which needs its `command` path edited to point at
wherever you placed `bin/bonez-session-sync.mjs` (Codex doesn't expand `${VAR}`/`~` in
`config.toml`, same caveat as the MCP `url` field above).

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (this repo IS its marketplace)
.mcp.json         the bonez MCP server (BONEZ_MCP_URL-overridable, OAuth by default)
skills/           8 skills
commands/         /bonez:context, /bonez:search
hooks/            PreToolUse write gate + SessionEnd session-capture hook
bin/              bonez-session-sync.mjs (session capture) + vendor/ (vendored @bonez/agent-import bundle)
server.json       MCP registry entry for the remote server
tests/            gate tests + session-capture tests (run in CI)
codex/            OpenAI Codex leg — AGENTS.md, skills/, prompts/, config.toml (see Install → OpenAI Codex; no write gate)
```

## Development

```bash
claude --plugin-dir .         # load the working tree for one session
./tests/test_gate.sh          # hook gate tests
./tests/test_session_sync.sh  # session-capture tests (stub gateway, no network)
claude plugin validate .
```

CI (`.github/workflows/check.yml`) enforces JSON validity, version parity across `plugin.json` / `marketplace.json` / `server.json`, `bash -n` on hooks, and the gate tests.
