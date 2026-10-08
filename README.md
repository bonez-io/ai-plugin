# bonez ai-plugin

The official [bonez](https://bonez.io) plugin for AI coding tools — your organization's **context graph** delivered into whatever coding agent you already use, over MCP.

Bonez indexes your org's repos, tickets, PRs, docs, conversations, and people into one knowledge graph, plus the durable memories its agents accumulate. This plugin connects that graph to your harness and teaches your agent how to use it well. It works against Bonez's own cloud and against **your own Bonez server** (for example `https://bonez.example.com`).

## Install

Open `https://<your server>/mcp/install` (for example `https://bonez.example.com/mcp/install`). It shows one command for your OS. It installs this plugin into every one of Claude Code, Codex and Cursor on the machine, pointed at your server:

```powershell
irm https://bonez.example.com/mcp/install.ps1 | iex      # Windows (PowerShell)
```

```bash
curl -fsSL https://bonez.example.com/mcp/install.sh | sh   # macOS and Linux
```

The server writes its own address into the plugin, because only Claude Code can ask for it at install time. The script is plain text at the same URL; read it first if you like. Then sign in once per tool:

| Tool | Sign in |
|---|---|
| Claude Code | `/mcp`, pick `bonez`, **Authenticate** |
| Codex (CLI and ChatGPT app) | the script opens the browser; or `codex mcp login bonez` |
| Cursor | reload the window, then **Customize > MCPs > bonez > Authenticate** |

Then try:

```text
/bonez:context
Search Bonez for how we handle webhook retries.
What breaks if I change <a symbol in this repo>?
Remember that the deploy script lives in infra/, not the app repo.
```

The last one saves a memory; the plugin asks you to approve every `graph_write` call (see [Write gate](#write-gate)).

### Bonez's own cloud (no script)

Each tool installs the plugin natively and points at `gateway.bonez.io` by default:

```bash
claude plugin install bonez --marketplace https://github.com/bonez-io/ai-plugin
codex plugin marketplace add bonez-io/ai-plugin && codex plugin add bonez@bonez
```

Cursor: copy [`cursor/`](cursor/) to `~/.cursor/plugins/local/bonez` (`%USERPROFILE%\.cursor\plugins\local\bonez` on Windows) and reload the window.

For your own server in Claude Code without the script, add `--config bonez_url=https://bonez.example.com` to the first command.

### Claude Code and an API key

OAuth is the default. For a machine with no browser, an admin of your server mints a key and you add the server yourself:

```bash
claude mcp add --transport http bonez https://bonez.example.com/mcp --header "Authorization: Bearer <key>"
```

The plugin ships its server **without** an `Authorization` header on purpose: Claude Code will not fall back to OAuth once any `Authorization` header is configured. If you use a key as well, you may see a second server named `plugin:bonez:bonez` that shows "needs authentication"; keep `bonez_url` equal to the URL in your `claude mcp add`. `/bonez:connect` explains this in the session.

## Windows

Claude Code, Codex and Cursor run on Windows 11. Before the one command:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Oven-sh.Bun --exact --version 1.3.14
```

Afterwards restart the tool itself (Claude Code, Codex, Cursor), not only the terminal: a running program keeps the PATH it started with, so it cannot see what `winget` just installed. **Git for Windows** gives Claude Code its Bash tool, and Claude Code and Cursor run this plugin's write gate (a bash script) through it; without it writes go through unprompted and reads are unaffected. **Node 18+** runs the hash and push tools. **bun** is only for `/bonez:new-plugin`. Every `.sh`, `.mjs`, `.json` and `.md` in this repo is LF on Windows too (`.gitattributes`), because a CRLF shell script does not run.

Cursor's gate runs `bash ./hooks/gate-write.sh`, so `bash` must be on the PATH Cursor starts with, and it must be Git Bash, not the WSL launcher in `C:\Windows\System32`. Git for Windows' default PATH option adds only Git itself; choose *Use Git and optional Unix tools from the Command Prompt* or add `C:\Program Files\Git\bin` to PATH.

There is no `cursor --add-mcp '<json>'` line for Windows: Windows PowerShell 5.1 and cmd strip the inner double quotes of that argument. Use the **Add to Cursor** button on the install page.

**Check the machine.** From a clone of this repo, `tests\windows-client-checks.ps1` prints PASS / FAIL / SKIP, with evidence, for everything above (Git Bash, node, bun, the CLIs, the hash tool on the shared vectors, a push to a fake gateway on 127.0.0.1, the write gate under Git Bash). It makes no network call except to localhost:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-client-checks.ps1
```

## Other clients and credentials

The Codex and Cursor legs ship pointing at Bonez's own cloud (`gateway.bonez.io`) and are written for that default; for your own Bonez server, change the URL as noted in each.

### OpenAI Codex

Codex installs this as a plugin (skills and the MCP server together), from the CLI or the ChatGPT desktop app, which share `~/.codex`:

```bash
codex plugin marketplace add bonez-io/ai-plugin
codex plugin add bonez@bonez
codex mcp login bonez
```

To build a Bonez plugin afterwards, ask Codex: `Use the new-plugin skill to create the Bonez plugin <name>`. The skill ships in the plugin, together with the hash and push tools it runs; a Codex plugin cannot ship custom prompts, which is why it is a skill and not a `/prompts:` command.

The plugin's [`codex/.mcp.json`](codex/.mcp.json) pins the sign-in to the Bonez CLI app with the `bonez:*` scopes: Codex asks only for OpenID scopes unless told, and its own client is not one every Bonez server's login knows. To add only the server by hand, paste [`codex/config.toml`](codex/config.toml) into `~/.codex/config.toml` (`$HOME\.codex\config.toml` on Windows).

Guidance ports:

- [`codex/AGENTS.md`](codex/AGENTS.md) — the graph and tool-lake skills (all
  but `creating-a-plugin` and `new-plugin`) compressed into always-in-context guidance. Copy to `~/.codex/AGENTS.md` (global) or
  `<repo>/AGENTS.md` (one repo); Codex concatenates whichever it finds up the
  directory tree.
- [`codex/skills/`](codex/skills/) — the same 10 skills, ported ~verbatim, plus
  `new-plugin` (the plugin creator, see below), because Codex turns out to support the same on-demand `SKILL.md` format
  Claude Code does. Copy the directory to `~/.agents/skills/` (user-wide) or
  `<repo>/.agents/skills/` (checked into a repo) — **not** `~/.codex/skills`,
  a common but wrong guess. AGENTS.md above is the belt; these are the
  suspenders, loaded on demand instead of always in context. `creating-a-plugin` and `new-plugin` reach the hash
  and push tools in [`codex/bin/`](codex/bin/) two folders above themselves (a plugin install has them
  there); a copy of `skills/` alone has no `bin/` beside it, so copy `codex/bin/` to `~/.agents/bin/` too, or run the tools from a
  clone of this repo. `new-plugin` is the flow of `/bonez:new-plugin` written for Codex's sandbox and skill paths
  (the same steps, the same HANDOFF block; CI pins it against `commands/new-plugin.md`), and it takes its scaffold
  from the `creating-a-plugin` folder beside it.
- [`codex/prompts/`](codex/prompts/) — `/prompts:context`,
  `/prompts:search` and `/prompts:agents`, ported from `commands/`. A plugin install does not register them as
  commands: copy to `~/.codex/prompts/` (top-level `.md` files only). Upstream marks custom prompts deprecated in
  favor of skills; included anyway since they still work today.

**Write approval.** Codex asks you before every `graph_write` call and every `rules` call.
The plugin's [`codex/.mcp.json`](codex/.mcp.json) sets `approval_mode = "prompt"` on both tools
(`"tools": { "graph_write": { "approval_mode": "prompt" }, "rules": { "approval_mode": "prompt" } }`),
and Codex's own prompt is the gate. Two differences from the Claude Code and Cursor gate:

- **Per tool, not per argument.** Codex cannot tell a `rules` `list`/`get` from a `save`, so `rules`
  asks for harmless reads too. That is the cost of a per-tool setting, and why the Codex copies of the
  `remembering` and `reviewing-with-org-rules` skills say so.
- **No hook.** A Codex `PreToolUse` hook can only allow or deny a call: `permissionDecision: "ask"` is
  parsed but not supported, so a hook cannot reproduce the Claude Code ask. The plugin ships none for this.
  `BONEZ_MCP_GATE_DISABLE` therefore has no effect on Codex.

The values of `approval_mode` are `auto` (the default: Codex decides), `prompt` (asks before every call
to the tool), `writes` (asks for tools not marked read-only) and `approve` (**runs the tool without
asking**, so never use it as a stop). `vendor_operation`, which no leg's gate covers (see
[Vendor operations](#vendor-operations)), is not in the plugin's file; the same `prompt` stanza,
commented out in [`codex/config.toml`](codex/config.toml), is the optional hard stop for it. A server
added by hand from `codex/config.toml` has no prompts until you uncomment the stanzas there.

### Cursor

Cursor has its own plugin marketplace, and this repo is a Cursor plugin — one
install brings the MCP server, the 10 skills, the commands (`/bonez-context`, `/bonez-search`,
`/bonez-agents`, `/bonez-new-plugin`), and the write gate. `cursor/mcp.json` carries a literal `https://gateway.bonez.io/mcp` URL and pins Bonez's own OAuth client (Cursor expands no `${VAR}`); to use your own Bonez server edit its `url` — that path has not been tested here.

**From the marketplace** (once listed): Command Palette -> `Cursor: Open Plugin
Marketplace`, search **bonez**, Install. Or `/add-plugin` in Agent chat, or
**Customize -> Install** to pick project or user scope.

**Before it is listed**, install it as a team marketplace or locally:

- **Team marketplace** — Dashboard -> Plugins -> **Team Marketplaces** ->
  **Add Marketplace** -> *Import from Repo*, pointed at
  `bonez-io/ai-plugin`. The repo root carries
  [`.cursor-plugin/marketplace.json`](.cursor-plugin/marketplace.json), which is
  what Cursor indexes. Set **Marketplace Access**, pick a distribution mode
  (*Default Off* / *Default On* / *Required*), and optionally **Enable Auto
  Refresh** — that needs the Cursor GitHub App on the repo and re-indexes at
  most once every 10 minutes.
- **Locally** — clone into `~/.cursor/plugins/local/` and reload Cursor.

Then run `/bonez-context`. The first tool call opens the browser sign-in — no
key to mint, same OAuth-by-default install as the Claude Code leg.

The plugin lives in [`cursor/`](cursor/) and uses Cursor's default paths, so
every part is discovered without configuration:

| Part | Path | What it is |
| --- | --- | --- |
| Manifest | `cursor/.cursor-plugin/plugin.json` | name, version, author |
| MCP server | `cursor/mcp.json` | OAuth by default |
| Skills | `cursor/skills/` | the same 10 `SKILL.md` files, byte-identical to `skills/` (CI-enforced), except `creating-a-plugin/SKILL.md`, whose tool paths are relative to the skill folder because Cursor has no plugin-root variable |
| Commands | `cursor/commands/` | `/bonez-context`, `/bonez-search`, `/bonez-agents`, `/bonez-new-plugin` |
| Tools | `cursor/bin/` | byte copies of `bin/bonez-package-hash.mjs`, `bin/bonez-plugin-push.mjs` and `bin/lib/` (for `/bonez-new-plugin`), and of the session-capture helper (CI-enforced) |
| Write gate | `cursor/hooks/hooks.json` | `beforeMCPExecution` -> `bash ./hooks/gate-write.sh` |
| Logo | `cursor/assets/logo.svg` | the bonez mark, declared as `"logo"` in the manifest |

`cursor/hooks/gate-write.sh` is a byte copy of the root `hooks/gate-write.sh`,
not a shim to it. A marketplace install copies the plugin directory **on its
own** — there is no repo behind it — so a hook reaching `../../hooks/` fails to
exec, and Cursor fails open, which means writes would go through unguarded. CI
pins the copy and runs the gate from a standalone directory to prove it.

Every hook command is spelled `bash ./hooks/<script>`, never the bare script path.
On Windows, Cursor hands a bare `.sh` path to the shell, and Windows opens it
through the Git Bash *file association* — a visible mintty window running
`bash --login -i <script>`, whose stdin is the terminal rather than Cursor's
pipe. The gate's `cat` then waits on the keyboard forever, the window never
closes, and (holding files open inside the plugin directory) blocks every
later uninstall or update. The `timeout` cannot reach that detached window.
Naming the interpreter runs the script in-process over stdio on every OS; where
`bash` is not on PATH the spawn fails and Cursor fails open (no gate, no
window), which is the right side to fail on.

**The write gate works here**, as a hook. Cursor's
`beforeMCPExecution` genuinely supports `permission: "ask"`, so `graph_write` calls and `rules`
writes get the same approval prompt Claude Code gives them; reads pass through
untouched. (Codex asks too, but through a per-tool setting that also prompts for `rules` reads; see
[OpenAI Codex](#openai-codex).)

Two details the gate has to absorb, because Cursor's own sources disagree:

- **Who identifies the server.** The [hooks
  docs](https://cursor.com/docs/agent/hooks) document `mcp_server_name`; the
  published `cursor-hooks` types carry `url`/`command` and no server name at
  all. The gate accepts *any* of `mcp_server_name`, `url`, or a flattened
  `mcp__bonez__…` tool name — requiring only the first would mean the gate
  silently never fires on a build that omits it.
- **Response casing.** The types declare `userMessage`/`agentMessage`; the docs
  page prints `user_message`/`agent_message`. Both spellings are emitted, since
  an unknown key is ignored either way. `permission` — the field that actually
  gates the call — is agreed by both.

**OAuth.** `cursor/mcp.json` pins `auth.CLIENT_ID` to the **Bonez CLI** Auth0
application rather than letting Cursor register its own client.

Dynamic registration is enabled on the tenant, but it creates **third-party**
clients, and that quota is already spent by the two clients Claude Code and
Codex registered for themselves (the `tpc_*` entries in the Auth0 application
list). A third registration returns
`403 — You reached the limit of entities of this type for this tenant`, and
Cursor then shows an Authenticate button that does nothing: no browser, no
error. Pinning a first-party client sidesteps the quota for good.

That application needs both of Cursor's fixed callbacks under **Allowed
Callback URLs**, and **Authorization Code** among its grant types — it had only
Device Code, which session capture uses:

```
http://localhost:8787/callback                      (desktop app)
https://www.cursor.com/agents/mcp/oauth/callback    (web / Cursor Agents)
```

Worth knowing when debugging: an existing install keeps working indefinitely off
its refresh token, so "it works in Codex" says nothing about whether a NEW client
can connect.

**Session-capture gap.** Cursor is not wired for session capture. Its transcripts
are opt-in and this repo has no parser for their on-disk format; both
`bin/bonez-session-sync.mjs` (format-specific parsers) and the gateway's wire
enum would need a Cursor case. Rather than ship a guess, the plugin carries **no**
`sessionEnd` hook — Claude Code and Codex remain the two legs that capture
sessions.

### Branding

The bonez mark ships wherever a manifest has somewhere to put it:

- **Cursor** — `"logo": "assets/logo.svg"` in the plugin manifest. It is an
  opaque tile (bonez paper ground, ink mark) rather than a bare glyph, because
  marketplace cards render on light *and* dark and are often rasterised, so a
  `prefers-color-scheme` trick inside the SVG cannot be relied on.
- **MCP registry** — `icons[]` in [`server.json`](server.json), one entry per
  `theme`, pointing at the light/dark marks already served from
  `console.bonez.io`. The registry schema requires an **HTTPS URL**, so these
  cannot be repo-relative paths.
- **Claude Code** — nothing to wire: its `plugin.json` / `marketplace.json`
  schemas document no icon, logo, or image field. `assets/` still carries the
  bare `bonez-mark-{light,dark}.svg` for the day one appears.

### Headless / CI: API key instead

OAuth needs a browser, so CI runners, remote boxes, and servers without OAuth use an API key
minted by an admin of your Bonez server (in the Bonez console under **API keys**; on Bonez's own
cloud, [console.bonez.io](https://console.bonez.io)). Add the header yourself — the shipped
`.mcp.json` deliberately omits it, because Claude Code will not fall back to OAuth once *any*
`Authorization` header is configured, even one that resolves empty:

```bash
export BONEZ_API_KEY=bnz_...
claude mcp add --transport http bonez https://<your server>/mcp \
  --header "Authorization: Bearer ${BONEZ_API_KEY}"
```

On Windows PowerShell:

```powershell
$env:BONEZ_API_KEY = "bnz_..."
claude mcp add --transport http bonez https://<your server>/mcp --header "Authorization: Bearer $env:BONEZ_API_KEY"
```

### Raw MCP (any client, no plugin)

Any MCP client that speaks OAuth discovery: point it at your server's streamable-HTTP endpoint
(`https://<your server>/mcp`; Bonez's own cloud is `https://gateway.bonez.io/mcp`) with no
`Authorization` header and let it 401 into the browser flow. Clients that don't: same endpoint,
`Authorization: Bearer <key>` header. The server also serves its own install page at
`https://<your server>/mcp/install`.

### Environment

| Variable | Purpose |
| --- | --- |
| `BONEZ_API_KEY` | Personal Bonez API key (`bnz_…`). Optional — used by the Codex `bearer_token_env_var` example and the CLI snippet above, and by `bin/bonez-plugin-push.mjs` (a `plugins`-scope key, see [Pushing a plugin](#pushing-a-plugin)); the Claude Code plugin itself never reads it. |
| `BONEZ_URL` | Your Bonez server (for example `https://bonez.example.com`; a trailing `/mcp` is dropped, a bare host gets `https://`). Read only by `bin/bonez-plugin-push.mjs`; no default, so a key is never sent to a server you did not name. |
| `BONEZ_ALLOW_HTTP` | Set to `1` to let `bonez-plugin-push` use a plain-`http` server on a private network (the key then travels unencrypted). Not needed for `https` or `localhost`. |
| `BONEZ_MCP_URL` | No longer read by `.mcp.json` — set the plugin's `bonez_url` option instead (see Install). [Session capture](#session-capture) still reads it, when `BONEZ_GATEWAY_URL` is unset. |
| `BONEZ_MCP_GATE_DISABLE` | Set to `1` to disable the write permission prompts of the Claude Code and Cursor hook (headless/CI runs). Codex's prompts come from `approval_mode` in `codex/.mcp.json` and ignore it. |
| `BONEZ_SESSION_SYNC` | Set to `0` to disable [session capture](#session-capture) without uninstalling. |
| `BONEZ_GATEWAY_URL` | Override the gateway session capture uploads to — qa or a local gateway. Falls back to `BONEZ_MCP_URL` with `/mcp` stripped, then `https://gateway.bonez.io` (the default; the override is for Bonez's own qa and local gateways — see Session capture). |

### API key scopes

`read` / `read+memory` / `read+write` are nested tiers for the MCP tool surface (`/mcp`).
`sessions` is a separate, disjoint lane for the [session capture](#session-capture) uploader's
two calls (`/api/import/presign`, `/api/import/{id}/complete`) — it never reaches `/mcp`, and an
MCP-scoped key never reaches the import routes. `plugins` is a third such lane, for [pushing a plugin](#pushing-a-plugin). Mint the smallest one that covers what you need:

| Scope | Unlocks |
| --- | --- |
| `read` | Everything read-only: `graph_schema`, `graph_query`, `graph_search`, `graph_fetch`, `graph_history`, plus `rules` list/get, `tool_search` and `vendor_operation_status`. It also runs `vendor_operation`, writes included: see the note below. |
| `read+memory` | `read`, plus `graph_write`. A read-only key gets `memory_scope_required`. |
| `read+write` | Everything: `read+memory`, plus `rules` save/update/delete. Rules bind every session in the org — hand these keys out deliberately. |
| `sessions` | Only `bonez-session-sync.mjs install` needs this. Reaches the session-import routes and nothing else — not `/mcp`, not the console. |
| `plugins` | Only `bonez-plugin-push.mjs` needs this. Reaches plugin upload and the plugin list and nothing else — not `/mcp`, not the rest of the console. An org admin mints it, and it stops working the moment its owner is no longer an admin: uploading a plugin deploys code onto your computers. |

**On servers released before Linear 1SI-2292, `vendor_operation` ignores the key's scope**: those servers check scope for `rules` writes and `graph_write` only, so a `read` key, or an OAuth token granted only `bonez:read`, can still run an operation that writes to a vendor (a Slack message, a GitLab note, a Linear issue). A read-only key is not a read-only guarantee for the tool lake on such a server; newer servers refuse a vendor write without the write scope (`write_scope_required`). See [Vendor operations](#vendor-operations).

## The tools

One loop: **`graph_search` → `graph_schema` → `graph_query` → `graph_fetch`**, plus the rulebook and the vendor tools.

| Tool | What it does |
| --- | --- |
| `graph_schema` | The graph's live schema and how to work with it: an overview, one type's detail, `find` for a matching sub-schema plus worked catalog queries, or a generated `guide`. Call it before guessing a type, field, edge or query name. |
| `graph_search` | Find starting nodes by keywords plus meaning. Each result is a `~hex` handle with its attached-memory count. |
| `graph_query` | Run a read-only BGQ query, or a stored catalog query by `name`; `at` reads the past. Memories cannot be queried. |
| `graph_fetch` | Read one node in full — a handle, node key or URL — with provenance, neighbours and its attached memories; reads a memory by its `m:…` id. |
| `graph_history` | Who changed what in the graph, and when: one node's history, one commit's diff, or the change feed. |
| `graph_write` | Typed memory operations — `remember`, `revise`, `claim`, `link`, `unlink`, `close` (and `note`); no delete. Needs the `memory` scope. Prompt-gated by this plugin. |
| `rules` | `list`/`get` the org's standing rules and slash commands freely; `save`/`update`/`delete` change binding guidance mounted into every session — write conservatively (prompt-gated by this plugin; needs a `read+write` key). |
| `tool_search`, `vendor_operation`, `vendor_operation_status` | The tool lake: find (`tool_search`), run (`vendor_operation`) and poll (`vendor_operation_status`) an operation on the vendor systems your org has connected: GitHub, GitLab, Jira, Linear, Monday, Sentry, Slack, Discord and databases. `vendor_operation` acts as the signed-in user, reads and writes alike. **Not gated by this plugin, and older servers do not check its key scope (1SI-2292)**: see [Vendor operations](#vendor-operations). |

A Bonez server also lists Slack-conversation tools (`send_message`, `read_thread`, `machine_attach`, and
others). They only work inside a Slack conversation turn and are refused for any other credential, so the
skills never use them.

### Write gate

`hooks/gate-write.sh` is a `PreToolUse` hook: Claude Code asks you before **every `graph_write` call** (every op
is a write; a `preflight` or `dry_run` asks too) and before `rules` `save`/`update`/`delete`. Reads pass
through untouched. For servers that still serve the retired `memory` tool, its `save`/`update`/`delete` are
gated the same way. `BONEZ_MCP_GATE_DISABLE=1` turns the prompts off for headless runs (PowerShell: `$env:BONEZ_MCP_GATE_DISABLE = "1"`). On Windows the hook is `bash "<plugin root>/hooks/gate-write.sh"`, run by Git Bash (see [Windows](#windows)).

Codex has no hook for this and does not need one: its plugin sets `approval_mode = "prompt"` on `graph_write` and `rules` in `codex/.mcp.json`, so Codex asks before every call to either, `rules` reads included (see [OpenAI Codex](#openai-codex)).

### Vendor operations

`tool_search`, `vendor_operation` and `vendor_operation_status` are the same tool lake the Bonez chat agent uses, served over MCP. The `using-the-tool-lake` skill teaches the flow: `tool_search` first, an `operation_id` copied from its result (never guessed), `vendor_operation` with the operation's own `input`, and `vendor_operation_status` for an `invocation_id` a result carried. If the org has not connected a vendor, the skill has the agent say so rather than work around it.

**What is not guarded.**

- **No write gate.** The write gate above does not cover `vendor_operation`, on any leg. The hook sees only the call (`operation_id`, `input`, `connection_ref`). Whether an operation reads or writes is the operation's `side_effect`, which the server returns in `tool_search` results and keeps in its catalog, not in the call. Gating on it would mean shipping a copy of the server's catalog (which differs by server version) or guessing from operation names, and a wrong guess is silence on a real write, so the plugin ships neither. `tests/test_gate.sh` pins the boundary.
- **The skill is an instruction, not a guard.** It tells the agent to describe in words, and wait for a yes, before any operation whose `side_effect` is not `read`. A model can still get that wrong. For a hard stop, leave `mcp__plugin_bonez_bonez__vendor_operation` off your Claude Code allow-list, so its default permission mode asks on every call (reads too), or, on Codex, uncomment the `vendor_operation` `approval_mode = "prompt"` stanza in [`codex/config.toml`](codex/config.toml).
- **Servers before Linear 1SI-2292 do not check the key's scope for `vendor_operation`** (see [API key scopes](#api-key-scopes)). On such a server, mint keys with that in mind: any key that reaches `/mcp` can run a write on every vendor your org has connected, as the user who owns the key.

**Agents, runs and sessions.** A server with the first-party `bonez` vendor serves them as read-only operations in the same lake (`bonez.agent.list.v1`, `bonez.agent.read.v1`, `bonez.run.list.v1`, `bonez.run.read.v1`, `bonez.session.list.v1`, `bonez.session.read.v1`), and `/bonez:agents` lists them. On an older server `tool_search` with vendor `bonez` returns nothing and the skill tells the agent to say so.

## Skills

Judgment for using the graph well — traps, defaults, when to stop:

- **session-context** — load the standing rules and the graph overview at task start; what a failed read means.
- **finding-prior-art** — search→fetch before building; memories are reached through their anchors; why absence proves nothing.
- **querying-the-graph** — the loop; never guess type, edge or query names; BGQ pitfalls; memories cannot be queried.
- **impact-analysis** — callers / blast radius / tests recipes and their depth traps.
- **remembering** — the `graph_write` policy: when, when not, never store; preflight first; new memories start `pending`.
- **citing-bonez-sources** — handles; never fabricate one; staleness and history.
- **who-owns-what** — people and ownership via the graph, not commit counts.
- **reviewing-with-org-rules** — pull the org's standing rules before reviewing.
- **creating-a-plugin** — write a Bonez plugin (a package that adds tools to agents): rules, template, hash, push to your server (or the manual handoff).
- **using-the-tool-lake** — find (`tool_search`), run (`vendor_operation`) and poll (`vendor_operation_status`) vendor operations: discover first and never guess an id, read `side_effect`, ask the user in words before anything that is not a read, what to say when a vendor is not connected, and how to list Bonez agents, runs and sessions through the `bonez` vendor.

Plus commands — `/bonez:context`, `/bonez:search <query>`, `/bonez:connect`, `/bonez:agents [name]` and `/bonez:new-plugin <name>` (scaffold, test, bundle, hash and push a new Bonez plugin; see the `creating-a-plugin` skill) on Claude Code, `/prompts:context`, `/prompts:search` and `/prompts:agents` on Codex (copied prompts; the plugin creator is the `new-plugin` skill there: ask `Use the new-plugin skill to create the Bonez plugin <name>`), `/bonez-context`, `/bonez-search`, `/bonez-agents` and `/bonez-new-plugin <name>` on Cursor.

The skills are shared, with deliberate exceptions: `codex/skills/` forks `remembering` and `reviewing-with-org-rules` because on Codex the prompt comes from the plugin's per-tool `approval_mode`, not from the hook, and `rules` asks for reads too, which the Claude/Cursor wording ("expect the harness to ask" on writes) does not say; `codex/skills/` also has `new-plugin`, the plugin creator, because a Codex plugin cannot ship the command that Claude Code and Cursor have; and `creating-a-plugin/SKILL.md` is rewritten in `cursor/` and `codex/` because it names the plugin's tools by `${CLAUDE_PLUGIN_ROOT}`, a variable only Claude Code expands (the other legs use `<skill folder>/../../bin/…`). CI pins that divergence to exactly those files, so any other drift fails the build.

## Session capture

Your Claude Code, Codex and Cursor conversations already hold everything the harness itself
learns from — what you tried, what broke, what you decided. This plugin can capture them into the same
`bonez` knowledge graph the desktop app's manual "Import history" feature feeds, so the org
learns from them too. It is **off by default** and stays off until you explicitly install it.

**Bonez's own gateways only.** Capture signs in to Bonez's own identity provider and uploads to Bonez's own
import pipeline, so it is not for a customer's Bonez server. `login` and `install` refuse any gateway host
other than `gateway.bonez.io` and `qa.gateway.bonez.io` (a loopback host is allowed, for a local gateway),
with a message saying so, and write nothing. The host checked is the one the script resolves from
`BONEZ_GATEWAY_URL`, then `BONEZ_MCP_URL` (minus `/mcp`), then the default `https://gateway.bonez.io`; the
plugin's `bonez_url` option is **not** visible to the script when you run it yourself. If your plugin
points at your own Bonez server, do not run `login` or `install`.

**What it does:** at the end of a matching session (Claude Code's `SessionEnd`; Codex's
`SessionEnd`, plus its `SessionStart` as a durable fallback for sessions that crashed or hit
Codex's tight `SessionEnd` timeout before it could fire; Cursor's `sessionEnd`), a hook hands
the transcript to
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
<plugin-root>/bin/bonez-session-sync.mjs login ...`). On Windows always use the second form, in
PowerShell: `node "$HOME\.claude\plugins\...\bin\bonez-session-sync.mjs" login --global`
(Windows does not read the `#!` line; the credential lives in `%USERPROFILE%\.bonez\session-sync\`,
protected by your profile's ACLs, since `chmod` is not enforced there). With no `--repo` given, `login` scopes
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
| `backfill [--dry-run] [--limit=N]` | Upload Claude Code history that predates capture being on. Oldest first, in bounded batches; re-run to continue. Start with `--dry-run` to see the volume first. |

**Catching up on what was missed.** Capture normally happens at `SessionEnd`. When that never
fires — a crash, a kill, or the plugin having been disabled for a while — the next session
started in the same directory flushes what was stranded there, so an ordinary gap heals on its
own. That per-workspace catch-up is deliberately capped, so it drains a session or two at a
time rather than stalling the start of your work.

It is not a way to import a year of history. For that, `backfill` sweeps every project
directory on the machine and uploads everything not already current:

```bash
bonez-session-sync.mjs backfill --dry-run   # how much would this publish?
bonez-session-sync.mjs backfill             # publish the first batch
```

It is a deliberate command and no hook ever triggers it, because it publishes a large volume of
past conversation to your organization's lake in one go. Each upload is recorded as it lands,
so interrupting it is safe and re-running continues where it stopped.

Kill switch: `BONEZ_SESSION_SYNC=0` disables capture without touching the installed
config — the same escape hatch `BONEZ_MCP_GATE_DISABLE` gives the write gate.

**Where the credential lives:** `~/.bonez/session-sync/` — agent-neutral, so **one `login`
covers all three clients**. It used to be `~/.claude/plugins/data/<plugin>-<marketplace>/`,
which only worked while Claude Code was the only leg: Cursor doesn't set `CLAUDE_PLUGIN_DATA`,
so it could never find a credential Claude Code had written under a marketplace named anything
but `bonez` — and a Cursor-only user got a `~/.claude/` directory for a product they don't use.
An existing install is found and moved on the next `login`/`install`/`status`; the old copy is
left in place in case an older build still reads it. `BONEZ_SESSION_SYNC_DATA` overrides the
location outright.

**Cursor leg:** nothing extra to enable — the plugin registers the `sessionEnd` hook itself
(`cursor/hooks/hooks.json`), so a `login` is the only step. Two differences worth knowing:

- Cursor's transcripts are thinner than the other two agents'. Records carry the role and the
  message content (including which tools were called) but **no timestamps, no working
  directory, and no git branch**. The workspace root is recovered from the hook payload
  (`workspace_roots`, falling back to `CURSOR_PROJECT_DIR`) — which is what makes `--repo`
  scoping work — and the conversation's timestamps stand in from the transcript file's own
  birthtime and mtime. Expect slightly coarser provenance on Cursor conversations than on
  Claude Code ones.
- **Cursor cannot run a command hook when you quit the app.** On `reason: window_close` it
  tears down its shell-exec service *before* running `sessionEnd` hooks, so every command hook
  in the batch dies with `MainThreadShellExec not initialized` — ours and any third-party one
  beside it (verified in Cursor 3.18.25's own hook log). Nothing plugin-side can fix that, so
  the Cursor leg also registers a **`sessionStart`** hook that flushes the previous
  conversations from disk on the next start. That is the path that actually carries most
  captures, and it covers crashes and SIGKILL for free. It flushes **every** stale conversation
  in the workspace (up to 20 per start), not just the last one — close a window with five chats
  open and all five sessionEnd hooks die together, so a one-per-start rule would never drain.
  A conversation counts as stale when it has never been uploaded *or* has been written to since
  its last upload, so a chat that keeps growing is re-captured rather than blacklisted. It
  never uploads the session just beginning.

  The **primary** trigger, though, is Cursor's `stop` hook: it fires after every agent turn,
  while the window is alive, independently per conversation — so three chats open at once each
  capture themselves instead of queueing behind one catch-up slot, and quitting the app loses
  nothing because the work is already uploaded. Uploading after every turn would be wasteful,
  so the uploader debounces (`BONEZ_SESSION_SYNC_DEBOUNCE_MS`, default 120s) and skips
  unchanged transcripts; a burst of quick turns collapses into one upload. `sessionEnd` and
  `sessionStart` remain as the safety net for whatever `stop` misses.
- `sessionEnd` is an IDE-lifetime event. Cursor's docs are explicit that "Cloud agents have no
  editor-lifetime session boundary. `sessionEnd` is tied to the IDE session, not a cloud agent
  chat" — so background/cloud agent conversations are **not** captured by this leg.
- Capture depends on Cursor writing transcripts at all. `transcript_path` is documented as
  nullable ("null if transcripts disabled"); when it is absent the uploader falls back to
  `CURSOR_TRANSCRIPT_PATH` and then to a walk of `~/.cursor/projects/*/agent-transcripts/`, but
  if Cursor has written nothing there is nothing to capture and the hook is a silent no-op.

**Codex leg:** hooks are opt-in per Codex install (`[features] hooks = true` in `config.toml`,
off by default) on top of this plugin's own `install` gate — see the commented-out block in
[`codex/config.toml`](codex/config.toml), which needs its `command` path edited to point at
wherever you placed `bin/bonez-session-sync.mjs` (Codex doesn't expand `${VAR}`/`~` in
`config.toml`, same caveat as the MCP `url` field above).

## Pushing a plugin

`/bonez:new-plugin <name>` builds a plugin and, as its last step, uploads it (Cursor: `/bonez-new-plugin <name>`; Codex: ask `Use the new-plugin skill to create the Bonez plugin <name>`). You can also push any
built plugin folder yourself (the `out/<name>/` of the creator: `package.json` and `dist/` only):

```bash
export BONEZ_URL=https://bonez.example.com   # your server (the /mcp address works too)
export BONEZ_API_KEY=bnz_...                 # scope "plugins", minted by an org admin
node bin/bonez-plugin-push.mjs ./my-plugin/out/my-plugin
node bin/bonez-plugin-push.mjs --status @acme/pi-my-plugin   # is it on the server, and does each computer have it?
```

On Windows PowerShell:

```powershell
$env:BONEZ_URL = "https://bonez.example.com"
$env:BONEZ_API_KEY = "bnz_..."
node "$env:USERPROFILE\.claude\plugins\cache\bonez\bonez\<version>\bin\bonez-plugin-push.mjs" .\my-plugin\out\my-plugin
```

**Where the tool is.** In a clone of this repo it is `bin\bonez-plugin-push.mjs` (and `bin\bonez-package-hash.mjs`). Installed with the plugin, it sits in the plugin's own folder under `bin/`: for Claude Code `~/.claude/plugins/cache/bonez/bonez/<version>/bin/` (on Windows `%USERPROFILE%\.claude\plugins\cache\bonez\bonez\<version>\bin\`, the path in the PowerShell line above; `<version>` is the folder named for the installed version), for Cursor `~/.cursor/plugins/cache/bonez-io-ai-plugin/bonez/<hash>/bin/` (`%USERPROFILE%\.cursor\plugins\cache\...` on Windows), for Codex the `bin/` of the installed `codex/` plugin folder (the skill finds it two folders above itself). Inside a Claude Code session with this plugin enabled, `bin/` is also on the Bash tool's `PATH`, so `bonez-plugin-push.mjs <folder>` works bare on macOS and Linux; on Windows call it as `node <path>`.
It needs only Node 18+. The tree hash is over bytes (line endings and a BOM are never normalised) and
its paths use `/` on every OS, so a folder built on Windows gets the gateway's hash.

**`$env:` only reaches that window.** A PowerShell `$env:BONEZ_API_KEY = ...` lives in that window and in the programs started from it. Run the push in the same window, or start Claude Code, Cursor or Codex from it; a copy started from the Start menu or from another window does not have the variables, and `/bonez:new-plugin` then prints the manual handoff instead of pushing.

It sends the folder as `{path: base64}` plus its tree sha256 (the algorithm of
`bonez-package-hash.mjs`) to `$BONEZ_URL/api/admin/org/plugins`. The server recomputes the hash,
vets the files, stores the version and makes it the active one. The command prints the plugin's
name, version, fingerprint and how many computers it rolls out to; if the server refuses, it prints
the refusal code and detail as sent. Exit codes: `0` uploaded, `1` refused by the server, `2` nothing
sent (bad folder or configuration), `3` server unreachable or answer unreadable.

- **The address.** `BONEZ_URL` is your server: `https://bonez.example.com`. A trailing `/mcp` (the address you gave your AI tool) and trailing slashes are dropped. A bare host works: `bonez.example.com` is tried over `https`, and `localhost:4000`, `127.0.0.1:4000` and `[::1]:4000` over `http`. When the server cannot be reached, the message names the full address it tried and says to check `BONEZ_URL`. A server with a self-signed or private-CA certificate fails the TLS check: point Node at the CA with `NODE_EXTRA_CA_CERTS` (`export NODE_EXTRA_CA_CERTS=/path/ca.pem`, or `$env:NODE_EXTRA_CA_CERTS = "C:\path\ca.pem"`); never switch the check off, the key would go to whoever answers.
- **The key.** Mint a key with the **plugins** scope in the console. It reaches plugin upload and
  the plugin list only, and the server checks on every request that its owner is still an org admin.
  The command never prints it, refuses to send it over plain `http` (except to `localhost`, or with
  `BONEZ_ALLOW_HTTP=1`) and does not follow redirects with it.
- **What the server accepts.** Only `package.json` and files under `dist/` ending in `.js .mjs .cjs .json .map .txt .md`; at most 32 files and 8 MiB; a lowercase npm-style name and a `version`. A folder you opened in Finder or Explorer may hold a `.DS_Store`, `Thumbs.db` or `desktop.ini`: the server refuses the upload, and the hash and push tools stop first and name the file. Delete it.
- **Checking it landed.** `bonez-plugin-push.mjs --status [<package name>]` prints the active version with its fingerprint (it must equal the push's) and each computer's state: `ready`, or `not_delivered` until its next heartbeat (about 30 seconds). Then choose the plugin in the agent builder's **Plugins** field (it writes the agent's `metadata.packages`, which the server hands the harness as the run plan's `execution.packages`).
- **What it does not carry.** Environment variables, apt packages and host mounts are not part of an
  upload; the creator prints them and an operator sets them once per computer.
- **Servers.** Needs a Bonez server release with plugin upload; an older server answers 404 and the
  command says so. Without `BONEZ_API_KEY` and `BONEZ_URL`, `/bonez:new-plugin` prints the manual
  handoff instead.

## Layout

```
.claude-plugin/   plugin.json + marketplace.json (this repo IS its marketplace)
.mcp.json         the bonez MCP server (URL from the plugin's bonez_url option, OAuth by default)
skills/           10 skills
commands/         /bonez:context, /bonez:search, /bonez:connect, /bonez:agents, /bonez:new-plugin
hooks/            PreToolUse write gate (graph_write / rules) + SessionEnd session-capture hook
bin/              bonez-session-sync.mjs (session capture) + vendor/ (vendored @bonez/agent-import bundle),
                  bonez-package-hash.mjs (plugin tree hash), bonez-plugin-push.mjs (one-command plugin upload),
                  lib/plugin-tree.mjs (the walk and tree hash those two share)
                  cursor/bin/ and codex/bin/ hold byte copies — a marketplace install ships only cursor/ or codex/, with no repo behind it
                  (cursor/bin/: session sync + vendor/, the hash and push tools + lib/; codex/bin/: the hash and push tools + lib/)
server.json       MCP registry entry for the remote server
tests/            gate tests + session-capture + plugin hash and push tests + Windows-portability tests and
                  windows-client-checks.ps1 (run in CI; the Windows ones on windows-latest too)
.gitattributes    LF for every text file, so a Windows clone (core.autocrlf=true) still runs the shell scripts
codex/            OpenAI Codex leg — AGENTS.md, skills/ (+ new-plugin, the plugin creator), prompts/ (context, search, agents), bin/ (plugin tools), .mcp.json (the server, sign-in and `approval_mode = "prompt"` on `graph_write` and `rules`), config.toml (see Other clients → OpenAI Codex; native prompts, no write hook)
assets/           the bonez mark — logo.svg (opaque tile) + bonez-mark-{light,dark}.svg
.cursor-plugin/   marketplace.json — this repo is a Cursor marketplace too
cursor/           the Cursor PLUGIN — .cursor-plugin/plugin.json, mcp.json, skills/, commands/ (incl. bonez-new-plugin), hooks/, bin/ (see Other clients → Cursor; write gate works, no session capture)
```

One gate script, two hook harnesses: `hooks/gate-write.sh` serves Claude Code's `PreToolUse`
and Cursor's `beforeMCPExecution` from the same script, dispatching on the payload's
`hook_event_name` and emitting each host's own response shape. Codex is excluded on
purpose — it parses `"ask"` but leaves it unimplemented, so the hook exits early there
rather than fighting its approval flow; Codex gets its prompts from `approval_mode = "prompt"`
in `codex/.mcp.json` instead. Skills are shared from `skills/` (Cursor and
Codex both read `SKILL.md` from `.agents/skills/`).

## Development

```bash
claude --plugin-dir .         # load the working tree for one session
./tests/test_gate.sh          # hook gate tests
./tests/test_session_sync.sh  # session-capture tests (stub gateway, no network)
./tests/test_package_hash.sh  # plugin tree-hash tests
./tests/test_plugin_push.sh   # plugin push tests (local http server, no network)
./tests/test_legs.sh          # the plugin creator on the Cursor and Codex legs: tool copies, skill forks, flows
./tests/test_codex_approval.sh # Codex asks before graph_write and rules; nothing sets approval_mode to approve
./tests/test_windows.sh       # shared tree-hash vectors, Windows paths, LF checkout, hook commands, push smoke test
claude plugin validate .                          # this repo's marketplace manifest
claude plugin validate .claude-plugin/plugin.json # the plugin manifest (incl. userConfig and .mcp.json)
```

On Windows run the same `.sh` files from Git Bash, or the Node ones directly: `node --test tests/plugin_tree.test.mjs tests/windows_portability.test.mjs tests/package_hash.test.mjs tests/plugin_push.test.mjs tests/fake_plugin_server.test.mjs tests/legs.test.mjs tests/codex_approval.test.mjs`.

`tests/lib/fake-plugin-server.mjs`, the gateway the push tests talk to, is a port of the real server's upload rules (`vet()` in bonez-core's `computers/plugins.py`); when that file changes, change the port and `tests/fake_plugin_server.test.mjs` in the same pull request. After editing `bin/bonez-package-hash.mjs`, `bin/bonez-plugin-push.mjs`, `bin/lib/plugin-tree.mjs` or the `creating-a-plugin` skill, copy the result into `cursor/` and `codex/` (`tests/legs.test.mjs` names what drifted).

CI (`.github/workflows/check.yml`) enforces JSON validity (including the Cursor manifests), version parity across `plugin.json` / `marketplace.json` / `server.json`, `bash -n` on hooks, the gate tests (Claude **and** Cursor protocol cases, including the plugin-root shim), the Codex approval test (`codex/.mcp.json` prompts on `graph_write` and `rules`; no file sets `approval_mode` to `approve`), skill-set parity across all three legs (Codex has `new-plugin` on top, nothing else) with the Codex divergence pinned (and the `creating-a-plugin` SKILL.md rewrites of Cursor and Codex checked line by line, with the plugin-creator tool copies and the Cursor command and Codex `new-plugin` skill held to the steps of `commands/new-plugin.md`, in `tests/legs.test.mjs`), and a Cursor plugin-structure check that resolves the marketplace source, asserts version parity across all five manifests, and executes the hook from the plugin root. A second job, on `windows-latest`, runs the tree-hash vectors, the push CLI against a fake gateway, the Windows path and line-ending guards, the write gate under Git Bash, and `tests/windows-client-checks.ps1` in Windows PowerShell 5.1 and PowerShell 7.
