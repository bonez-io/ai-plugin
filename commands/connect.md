---
name: connect
description: Connect this plugin to your own Bonez server and sign in — OAuth or an API key
argument-hint: [server URL]
---

# /bonez:connect

Walk the user through connecting to THEIR Bonez server (for example `https://bonez.example.com`) and authenticating. Explain; do not guess. Never ask the user to paste an API key into this chat — the key goes into a shell command they run themselves.

## 1. Point the plugin at the server

The plugin asks for the **Bonez server URL** (option `bonez_url`) when it is enabled. Give the server's address only — no trailing slash and no `/mcp`; the plugin adds `/mcp`. The default is Bonez's own cloud, `https://gateway.bonez.io`. If the user passed one (`$ARGUMENTS`), use it.

To see or change it later: open `/config` and edit the Bonez plugin's `bonez_url` row, or from a shell:

```bash
echo '{"bonez_url":"https://bonez.example.com"}' | claude plugin configure bonez@bonez --values-stdin
```

Then restart Claude Code so the server connects to the new address. The server also serves its own copy-paste install page at `<server URL>/mcp/install`.

## 2. Authenticate — pick ONE

**A. OAuth** — when the server has OAuth enabled. Run `/mcp`, select the Bonez server (`plugin:bonez:bonez`), choose **Authenticate**, and finish the sign-in in the browser. If the server has no OAuth set up, Authenticate will not complete; use B.

**B. An API key minted by a Bonez admin** — for a headless box, CI, or a server without OAuth. The key's scope decides what the agent can do: `read` reads everything; `read+memory` also lets it save memories with `graph_write`; `read+write` also lets it change the org's rules. Ask the admin for the smallest that covers the work, then run this yourself in a shell, with the server's URL:

```bash
claude mcp add --transport http bonez https://bonez.example.com/mcp --header "Authorization: Bearer <key>"
```

## 3. Why you may see two Bonez servers

The plugin deliberately ships its MCP server with NO `Authorization` header: Claude Code will not fall back to OAuth once any `Authorization` header is configured. So the plugin's own server, `plugin:bonez:bonez`, can only ever sign in with OAuth — it cannot take a key.

That means a user who adds a key with `claude mcp add` (B) AND keeps the plugin installed can end up with two servers: `bonez` (your key, works) and `plugin:bonez:bonez` (OAuth only, shows "needs authentication" until you sign in). If the OAuth one is not wanted, ignore it or disable it in `/mcp`. Claude Code's MCP documentation says a plugin server that points at the same endpoint as a server you added yourself counts as a duplicate and is connected once, using yours — so setting the plugin's `bonez_url` to the same address you used in `claude mcp add` should leave just one. That is the documented behaviour, not something this plugin tests.

The skills and the write prompt work with either server name (`mcp__bonez__…` or `mcp__plugin_bonez_bonez__…`).

## 4. Check it worked

`/mcp` should list the server as connected. Then run `/bonez:context`. If a call fails with `memory_scope_required` or `write_scope_required`, the key is too narrow for that operation — that is a scope decision for the admin, not a connection fault.
