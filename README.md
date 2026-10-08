# bonez ai-plugin

The official [bonez](https://bonez.io) plugin for AI coding tools — your organization's **context graph** delivered into whatever coding agent you already use, over MCP.

Bonez indexes your org's repos, tickets, PRs, docs, conversations, and people into one knowledge graph, plus the durable memories its agents accumulate. This plugin connects that graph to your harness and teaches your agent how to use it well. It works against Bonez's own cloud and against **your own Bonez server** (for example `https://bonez.example.com`).

## Install for your own Bonez server

Claude Code. Five steps:

1. **Add the marketplace.**

   ```bash
   claude plugin marketplace add bonez-io/ai-plugin
   ```

2. **Install the plugin.**

   ```bash
   claude plugin install bonez@bonez
   ```

3. **Set your server URL.** Claude Code asks for the **Bonez server URL** when the plugin is enabled. Enter your server's address — for example `https://bonez.example.com`, with no trailing slash and no `/mcp` (the plugin adds it). On Bonez's own cloud, keep the default (`https://gateway.bonez.io`). Change it later in `/config`, or from a shell:

   ```bash
   echo '{"bonez_url":"https://bonez.example.com"}' | claude plugin configure bonez@bonez --values-stdin
   ```

   then restart Claude Code.

4. **Authenticate.** Pick one:

   - **OAuth**, when your server has OAuth enabled: run `/mcp`, choose the Bonez server (`plugin:bonez:bonez`), then **Authenticate**, and finish the sign-in in your browser.
   - **An API key** minted by an admin of your server (no browser, or a server without OAuth). Run, with your server's URL:

     ```bash
     claude mcp add --transport http bonez https://bonez.example.com/mcp --header "Authorization: Bearer <key>"
     ```

   The plugin ships its server **without** an `Authorization` header on purpose: Claude Code will not fall back to OAuth once any `Authorization` header is configured, so the plugin's own server can only sign in with OAuth. If you use a key as well, you may see a second server named `plugin:bonez:bonez` that shows "needs authentication"; per Claude Code's MCP docs a plugin server pointing at the same endpoint as one you added yourself counts as a duplicate, so keep `bonez_url` equal to the URL in your `claude mcp add`. `/bonez:connect` explains all of this in the session.

5. **Try it.**

   ```text
   /bonez:context
   Search Bonez for how we handle webhook retries.
   What breaks if I change <a symbol in this repo>?
   Remember that the deploy script lives in infra/, not the app repo.
   ```

   The last one saves a memory; the plugin asks you to approve every `graph_write` call (see [Write gate](#write-gate)).

## Other clients and credentials

The Codex and Cursor legs ship pointing at Bonez's own cloud (`gateway.bonez.io`) and are written for that default; for your own Bonez server, change the URL as noted in each.

### OpenAI Codex

MCP config in Codex lives in `~/.codex/config.toml`, shared by Codex CLI, the
IDE extension, and the desktop app — no separate GUI "add server" flow is
documented beyond that shared file, so config.toml (directly or via the CLI)
is the one path in:

```bash
codex mcp add bonez --url https://gateway.bonez.io/mcp   # your own server: https://<your server>/mcp
codex mcp login bonez   # run OAuth now instead of waiting for a 401
```

Or paste [`codex/config.toml`](codex/config.toml) into `~/.codex/config.toml`
yourself — same OAuth-by-default install as Claude Code (`auth` defaults to
`"oauth"` for a streamable-HTTP server with no bearer token configured).

Guidance ports:

- [`codex/AGENTS.md`](codex/AGENTS.md) — the graph and tool-lake skills (all
  but `creating-a-plugin`) compressed into always-in-context guidance. Copy to `~/.codex/AGENTS.md` (global) or
  `<repo>/AGENTS.md` (one repo); Codex concatenates whichever it finds up the
  directory tree.
- [`codex/skills/`](codex/skills/) — the same 10 skills, ported ~verbatim,
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
interactive approval before every `graph_write` call and every `rules` write,
because rules bind every future session in the org. Codex has no equivalent: its `PreToolUse`
hook can only unconditionally allow or deny a call — `permissionDecision:
"ask"` is parsed but explicitly unimplemented upstream, and Codex fails open
(marks the hook run failed, lets the call through) rather than blocking. The
closest native substitute is `approval_mode = "approve"` on the MCP server's
`graph_write`/`rules` tools in `config.toml` (commented out in
[`codex/config.toml`](codex/config.toml)), but that prompts for *every* call
including `rules` `list`/`get` reads, not just writes. **Writes are
unguarded by default on the Codex leg — there is no bundled equivalent of
the Claude Code gate.** The same commented block also lists `vendor_operation`,
which no leg's gate covers (see [Vendor operations](#vendor-operations)).

### Cursor

Cursor has its own plugin marketplace, and this repo is a Cursor plugin — one
install brings the MCP server, the 10 skills, both commands, and the write gate. `cursor/mcp.json` carries a literal `https://gateway.bonez.io/mcp` URL and pins Bonez's own OAuth client (Cursor expands no `${VAR}`); to use your own Bonez server edit its `url` — that path has not been tested here.

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
| Skills | `cursor/skills/` | the same 10 `SKILL.md` files, byte-identical to `skills/` (CI-enforced) |
| Commands | `cursor/commands/` | `/bonez-context`, `/bonez-search` |
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

**The write gate works here** — unlike the Codex leg. Cursor's
`beforeMCPExecution` genuinely supports `permission: "ask"`, so `graph_write` calls and `rules`
writes get the same approval prompt Claude Code gives them; reads pass through
untouched.

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
| `BONEZ_URL` | Your Bonez server (for example `https://bonez.example.com`, no trailing path). Read only by `bin/bonez-plugin-push.mjs`; no default, so a key is never sent to a server you did not name. |
| `BONEZ_ALLOW_HTTP` | Set to `1` to let `bonez-plugin-push` use a plain-`http` server on a private network (the key then travels unencrypted). Not needed for `https` or `localhost`. |
| `BONEZ_MCP_URL` | No longer read by `.mcp.json` — set the plugin's `bonez_url` option instead (see Install). [Session capture](#session-capture) still reads it, when `BONEZ_GATEWAY_URL` is unset. |
| `BONEZ_MCP_GATE_DISABLE` | Set to `1` to disable the write permission prompts (headless/CI runs). |
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
gated the same way. `BONEZ_MCP_GATE_DISABLE=1` turns the prompts off for headless runs.

### Vendor operations

`tool_search`, `vendor_operation` and `vendor_operation_status` are the same tool lake the Bonez chat agent uses, served over MCP. The `using-the-tool-lake` skill teaches the flow: `tool_search` first, an `operation_id` copied from its result (never guessed), `vendor_operation` with the operation's own `input`, and `vendor_operation_status` for an `invocation_id` a result carried. If the org has not connected a vendor, the skill has the agent say so rather than work around it.

**What is not guarded.**

- **No write gate.** The write gate above does not cover `vendor_operation`, on any leg. The hook sees only the call (`operation_id`, `input`, `connection_ref`). Whether an operation reads or writes is the operation's `side_effect`, which the server returns in `tool_search` results and keeps in its catalog, not in the call. Gating on it would mean shipping a copy of the server's catalog (which differs by server version) or guessing from operation names, and a wrong guess is silence on a real write, so the plugin ships neither. `tests/test_gate.sh` pins the boundary.
- **The skill is an instruction, not a guard.** It tells the agent to describe in words, and wait for a yes, before any operation whose `side_effect` is not `read`. A model can still get that wrong. For a hard stop, leave `mcp__plugin_bonez_bonez__vendor_operation` off your Claude Code allow-list, so its default permission mode asks on every call (reads too), or use the commented `approval_mode = "approve"` stanza in [`codex/config.toml`](codex/config.toml).
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

Plus commands — `/bonez:context`, `/bonez:search <query>`, `/bonez:connect`, `/bonez:agents [name]` and `/bonez:new-plugin <name>` (scaffold, test, bundle, hash and push a new Bonez plugin; see the `creating-a-plugin` skill) on Claude Code, `/prompts:context`, `/prompts:search` and `/prompts:agents` on Codex, `/bonez-context`, `/bonez-search` and `/bonez-agents` on Cursor.

The skills are shared, with one deliberate exception: `codex/skills/` forks `remembering` and `reviewing-with-org-rules` because Codex has no write gate, so the Claude/Cursor wording ("expect the harness to ask") would be false there. CI pins that divergence to exactly those two files, so any other drift fails the build.

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

`/bonez:new-plugin <name>` builds a plugin and, as its last step, uploads it. You can also push any
built plugin folder yourself (the `out/<name>/` of the creator: `package.json` and `dist/` only):

```bash
export BONEZ_URL=https://bonez.example.com   # your server
export BONEZ_API_KEY=bnz_...                 # scope "plugins", minted by an org admin
node bin/bonez-plugin-push.mjs ./my-plugin/out/my-plugin
```

Inside a Claude Code session with this plugin enabled, `bin/` is on the Bash tool's `PATH`, so
`bonez-plugin-push.mjs <folder>` works bare. It needs only Node 18+.

It sends the folder as `{path: base64}` plus its tree sha256 (the algorithm of
`bonez-package-hash.mjs`) to `$BONEZ_URL/api/admin/org/plugins`. The server recomputes the hash,
vets the files, stores the version and makes it the active one. The command prints the plugin's
name, version, fingerprint and how many computers it rolls out to; if the server refuses, it prints
the refusal code and detail as sent. Exit codes: `0` uploaded, `1` refused by the server, `2` nothing
sent (bad folder or configuration), `3` server unreachable or answer unreadable.

- **The key.** Mint a key with the **plugins** scope in the console. It reaches plugin upload and
  the plugin list only, and the server checks on every request that its owner is still an org admin.
  The command never prints it, refuses to send it over plain `http` (except to `localhost`, or with
  `BONEZ_ALLOW_HTTP=1`) and does not follow redirects with it.
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
                  bonez-package-hash.mjs (plugin tree hash), bonez-plugin-push.mjs (one-command plugin upload)
                  cursor/bin/ is a byte copy — a marketplace install ships only cursor/, with no repo behind it
server.json       MCP registry entry for the remote server
tests/            gate tests + session-capture + plugin hash and push tests (run in CI)
codex/            OpenAI Codex leg — AGENTS.md, skills/, prompts/, config.toml (see Other clients → OpenAI Codex; no write gate)
assets/           the bonez mark — logo.svg (opaque tile) + bonez-mark-{light,dark}.svg
.cursor-plugin/   marketplace.json — this repo is a Cursor marketplace too
cursor/           the Cursor PLUGIN — .cursor-plugin/plugin.json, mcp.json, skills/, commands/, hooks/ (see Other clients → Cursor; write gate works, no session capture)
```

One gate, three harnesses: `hooks/gate-write.sh` serves Claude Code's `PreToolUse`
and Cursor's `beforeMCPExecution` from the same script, dispatching on the payload's
`hook_event_name` and emitting each host's own response shape. Codex is excluded on
purpose — it parses `"ask"` but leaves it unimplemented, so the hook exits early there
rather than fighting its approval flow. Skills are shared from `skills/` (Cursor and
Codex both read `SKILL.md` from `.agents/skills/`).

## Development

```bash
claude --plugin-dir .         # load the working tree for one session
./tests/test_gate.sh          # hook gate tests
./tests/test_session_sync.sh  # session-capture tests (stub gateway, no network)
./tests/test_package_hash.sh  # plugin tree-hash tests
./tests/test_plugin_push.sh   # plugin push tests (local http server, no network)
claude plugin validate .                          # this repo's marketplace manifest
claude plugin validate .claude-plugin/plugin.json # the plugin manifest (incl. userConfig and .mcp.json)
```

CI (`.github/workflows/check.yml`) enforces JSON validity (including the Cursor manifests), version parity across `plugin.json` / `marketplace.json` / `server.json`, `bash -n` on hooks, the gate tests (Claude **and** Cursor protocol cases, including the plugin-root shim), skill-set parity across all three legs with the Codex divergence pinned, and a Cursor plugin-structure check that resolves the marketplace source, asserts version parity across all five manifests, and executes the hook from the plugin root.
