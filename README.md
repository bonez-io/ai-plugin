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
```

## Development

```bash
claude --plugin-dir . # load the working tree for one session
./tests/test_gate.sh  # hook gate tests
claude plugin validate .
```

CI (`.github/workflows/check.yml`) enforces JSON validity, version parity across `plugin.json` / `marketplace.json` / `server.json`, `bash -n` on hooks, and the gate tests.
