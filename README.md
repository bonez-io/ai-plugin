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

### API key scopes

Keys come in three tiers — mint the smallest one that covers what your agent does:

| Scope | Unlocks |
| --- | --- |
| `read` | Everything read-only: `search`, `schema`, `query`, `fetch`, `context`, plus `memory` recall and `rules` list/get. |
| `read+memory` | `read`, plus `memory` save/update/delete. |
| `read+write` | Everything: `read+memory`, plus `rules` save/update/delete. Rules bind every session in the org — hand these keys out deliberately. |

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

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (this repo IS its marketplace)
.mcp.json         the bonez MCP server (BONEZ_MCP_URL-overridable, OAuth by default)
skills/           8 skills
commands/         /bonez:context, /bonez:search
hooks/            PreToolUse gate prompting before memory and rules writes
server.json       MCP registry entry for the remote server
tests/            gate tests (run in CI)
codex/            OpenAI Codex leg — AGENTS.md, skills/, prompts/, config.toml (see Install → OpenAI Codex; no write gate)
```

## Development

```bash
claude --plugin-dir . # load the working tree for one session
./tests/test_gate.sh  # hook gate tests
claude plugin validate .
```

CI (`.github/workflows/check.yml`) enforces JSON validity, version parity across `plugin.json` / `marketplace.json` / `server.json`, `bash -n` on hooks, and the gate tests.
