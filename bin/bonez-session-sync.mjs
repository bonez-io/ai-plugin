#!/usr/bin/env node
// bonez-session-sync — captures Claude Code, Codex and Cursor conversation transcripts at
// session end
// and uploads them into the org's bonez knowledge graph, the same pipeline the desktop app's
// manual "Import history" feature feeds (SPEC-mcp-session-capture.md).
//
// Two very different runtime shapes live in this one file:
//
//   `hook`    — invoked directly by a Claude Code / Codex / Cursor lifecycle hook.
//               Budget-critical:
//               Claude Code gives ALL SessionEnd hooks a combined 1.5s (raisable to 60s per
//               hook); Codex caps SessionEnd at 1s default / 3s hard max inside a 5s teardown
//               bound. This path does only synchronous local I/O (read stdin, check config,
//               write a small temp file, spawn a detached child) and returns — it never makes
//               a network call itself.
//   `_upload` — the detached background worker `hook` spawns. Unbounded by the hook budget
//               (it is unref'd and its stdio is fully cut loose before `hook` returns), so
//               this is where the parse/scrub/presign/PUT/complete chain actually runs.
//
// Both paths share one hard invariant: NEVER write to stdout, NEVER exit non-zero. A hook the
// user notices — because it printed something or made Claude Code report a failed hook — is a
// hook that erodes trust in the whole plugin. Every top-level dispatch below is wrapped so a
// bug in here degrades to "silently did nothing" rather than a visible failure.
//
// `install` / `status` / `enable` / `disable` are the human-facing subcommands — those DO
// print, since a person typed the command and is waiting on the answer.
//
// Vendors @bonez/agent-import's prebuilt bundle verbatim from harness-ui
// (packages/agent-import/bundle/agent-import.bundle.mjs, commit b07910990c4ba2e70e13c9656f61
// 198fa2cba90c) at bin/vendor/agent-import.bundle.mjs — Node builtins only, no npm install
// needed. Do not hand-edit that file; re-vendor it verbatim when harness-ui's source changes.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { hostname, homedir, platform } from "node:os"
import { join } from "node:path"
import { gzipSync } from "node:zlib"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"

import {
  HOME,
  Scrubber,
  normalizeRepos,
  parseClaudeFile,
  parseCodexFile,
  paths,
  repoFor,
  walkFiles,
} from "./vendor/agent-import.bundle.mjs"

const SELF_PATH = fileURLToPath(import.meta.url)

// A session that re-fires SessionEnd (or a Codex SessionStart catch-up scan that keeps
// re-selecting the same stale file) shouldn't re-upload more than once inside this window,
// even if the content genuinely changed again in that time. Overridable for tests.
// `|| 120_000` would be wrong here: BONEZ_SESSION_SYNC_DEBOUNCE_MS=0 (tests use this to disable
// debounce outright) is falsy, so `||` would silently discard it and fall back to the default.
const _parsedDebounceMs = Number.parseInt(process.env.BONEZ_SESSION_SYNC_DEBOUNCE_MS ?? "", 10)
const DEBOUNCE_MS = Number.isFinite(_parsedDebounceMs) && _parsedDebounceMs >= 0 ? _parsedDebounceMs : 120_000

// How many stale Cursor conversations one sessionStart may flush. Concurrency is the reason
// this is not 1: close a window with five chats open and all five sessionEnd hooks die
// together (see findCursorCatchupTargets), so a one-per-start rule would need five more
// sessions to drain — and with steady use the backlog grows faster than it clears.
// It is not unbounded either: every upload is a separate S3 archive, and the pipeline's
// agent-convos adapter still re-reads every archive under imports/{org}/ on each run (the
// `upload_key` filter in SPEC-mcp-session-capture §3.5 has not landed), so upload count is
// not free. Twenty covers any realistic window; the rest drain on later starts.
const CURSOR_CATCHUP_MAX = 20

// The public OAuth client this plugin authenticates as (see the credential section below).
// PUBLIC by design and safe to ship in a distributed CLI: it is an identifier, not a secret
// (RFC 8252 §8.5), and it grants nothing on its own — every token still requires the user's
// own browser sign-in, and the scope it may ask for (`bonez:sessions`) is upload-only.
// Verified 2026-08-25 against both the prod and qa MCP audiences: POST /oauth/device/code
// returns a device_code + user_code rather than "unknown client".
// Empty would make `login` refuse with a pointer at the key lane instead of failing deep in
// the flow. BONEZ_OAUTH_CLIENT_ID overrides it for testing against another Auth0 app.
const OAUTH_CLIENT_ID_BUILTIN = "qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm"

// -------------------------------------------------------------------------------- data dir

// ${CLAUDE_PLUGIN_DATA} is the writable, per-plugin, per-user directory Claude Code sets for
// every hook process: `~/.claude/plugins/data/{id}/`, where `{id}` is `{plugin-name}-
// {marketplace-name}` (non `[A-Za-z0-9_-]` characters replaced with `-`) — e.g. `formatter@my-
// marketplace` resolves to `.../data/formatter-my-marketplace/` (verified against
// code.claude.com/docs/en/plugins-reference.md; it is NOT simply the plugin's bare manifest
// `name`, which is what an earlier draft of this file wrongly assumed). This plugin ships as
// both plugin name AND marketplace name "bonez" (`.claude-plugin/plugin.json` /
// `marketplace.json`), so the documented `marketplace add bonez-io/ai-plugin` + `install
// bonez@bonez` flow resolves to `.../data/bonez-bonez/` — the fallback below.
//
// Two processes need to agree on this path WITHOUT the env var necessarily being set: a human
// running `install` from their own shell (unless they run it via a Claude Code session's Bash
// tool while this plugin is enabled — bin/ is on that PATH per docs/en/plugins.md, and that
// subprocess DOES inherit the real CLAUDE_PLUGIN_DATA, so the recommended install path in the
// README already gets the exact right value for free), and the Codex hook process (Codex has
// no CLAUDE_PLUGIN_DATA of its own — its config.toml install here is a manual paste, not a real
// plugin load, so it always hits this fallback). A key installed one way must be visible to a
// hook firing the other way, so the fallback has to be this same computed path, not some
// unrelated directory of our own choosing.
// What we can honestly claim about the stored key's protection. `chmod 0o600` is not a
// permission model on Windows — Node maps it onto the read-only flag, so the file stays
// readable by every account on the machine. Saying "mode 600" there would be a false
// promise about a credential, so the message states what is actually true per platform.
function credentialProtection() {
  return process.platform === "win32"
    ? "protected by your Windows user profile's ACLs — chmod is not enforced on Windows"
    : "mode 600 — this machine only"
}

// WHERE THE CREDENTIAL LIVES.
//
// This used to be `CLAUDE_PLUGIN_DATA || ~/.claude/plugins/data/bonez-bonez`, which was fine
// while Claude Code was the only client: Claude Code sets that variable, so the fallback was
// nearly dead code. Adding the Cursor leg broke both halves of that assumption.
//
//   - Cursor sets CLAUDE_PROJECT_DIR (for Claude Code compat) but NOT CLAUDE_PLUGIN_DATA, so
//     it always takes the fallback — a literal, hardcoded path.
//   - Claude Code derives its data dir as `<plugin>-<marketplace>`. Install this plugin from a
//     marketplace named anything other than `bonez` and the credential lands in, say,
//     `bonez-acme` — which Cursor's fallback will never look at. `login` in Claude Code, then
//     capture nothing in Cursor, with no error anywhere. (Observed locally: two stores,
//     `bonez/` and `bonez-bonez/`, holding two different credentials.)
//   - A Cursor-only user has no Claude Code at all, and `login` would create ~/.claude/ on
//     their machine for a product they do not use.
//
// So the store is now agent-neutral, and resolution prefers wherever a config ALREADY is —
// an existing install must never lose its credential to a path change. Fresh installs land in
// the neutral location, and legacy stores are migrated on first write (see migrateLegacyData).
const CANONICAL_DATA_DIR = join(homedir(), ".bonez", "session-sync")

// The legacy locations, most-specific first. CLAUDE_PLUGIN_DATA is what Claude Code hands us
// and is authoritative when set; the hardcoded path below it is where every install before
// this change landed.
function legacyDataDirs() {
  const dirs = [process.env.CLAUDE_PLUGIN_DATA].filter(Boolean)
  // Claude Code names its per-plugin data dir `<plugin>-<marketplace>`, so the marketplace the
  // user happened to add this from is baked into the path: `bonez-bonez`, `bonez-acme`, ...
  // Guessing one name is what caused the split in the first place — enumerate instead, newest
  // config first (the most likely current credential when a machine has several).
  const claudeData = join(homedir(), ".claude", "plugins", "data")
  try {
    const found = readdirSync(claudeData)
      .filter((n) => n === "bonez" || n.startsWith("bonez-"))
      .map((n) => join(claudeData, n))
      .filter((d) => existsSync(join(d, "config.json")))
      .map((d) => ({ d, mtime: statSync(join(d, "config.json")).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .map((x) => x.d)
    dirs.push(...found)
  } catch {
    /* no ~/.claude at all — the common case for a Cursor-only user */
  }
  return dirs
}

// Resolved once per process: `dataDir()` is called repeatedly on the hook fast path and there
// is no reason to re-stat for each one.
let _dataDir
function dataDir() {
  if (_dataDir) return _dataDir
  // An explicit override always wins — tests rely on this, and it is the escape hatch for
  // anyone with an unusual layout.
  const explicit = process.env.BONEZ_SESSION_SYNC_DATA || process.env.CLAUDE_PLUGIN_DATA
  if (explicit) {
    _dataDir = explicit
    return _dataDir
  }
  if (existsSync(join(CANONICAL_DATA_DIR, "config.json"))) {
    _dataDir = CANONICAL_DATA_DIR
    return _dataDir
  }
  for (const d of legacyDataDirs()) {
    if (existsSync(join(d, "config.json"))) {
      _dataDir = d
      return _dataDir
    }
  }
  _dataDir = CANONICAL_DATA_DIR
  return _dataDir
}

// Prints ONLY when something actually moved. Silent otherwise — `status` output gets pasted
// into issues and does not need a line about a migration that never happened.
function reportMigration() {
  const from = migrateLegacyData()
  if (from) {
    console.log(`Moved your session-capture credential to ${CANONICAL_DATA_DIR}`)
    console.log(`  (was ${from} — left in place, in case an older install still reads it)`)
    console.log("  This is why Cursor and Claude Code now share one sign-in.")
    console.log("")
  }
}

// Called from the human-facing commands only (never the hook path): if the credential still
// lives in a legacy directory, copy it to the neutral one so every client converges on a
// single store. The legacy copy is deliberately LEFT IN PLACE — an older build of this script,
// or another agent's plugin install, may still be reading it, and orphaning their credential
// to tidy up a directory would be a poor trade.
function migrateLegacyData() {
  // An explicit override is a deliberate choice by the caller — never migrate out from under
  // it. (Without this, `install` with CLAUDE_PLUGIN_DATA set would write there and the very
  // next `status` would move it to the canonical path and report THAT instead.)
  if (process.env.BONEZ_SESSION_SYNC_DATA || process.env.CLAUDE_PLUGIN_DATA) return null
  if (existsSync(join(CANONICAL_DATA_DIR, "config.json"))) return null
  const from = legacyDataDirs().find((d) => existsSync(join(d, "config.json")))
  if (!from || from === CANONICAL_DATA_DIR) return null
  try {
    mkdirSync(CANONICAL_DATA_DIR, { recursive: true, mode: 0o700 })
    for (const f of ["config.json", "sync-state.json"]) {
      if (existsSync(join(from, f))) writeFileSync(join(CANONICAL_DATA_DIR, f), readFileSync(join(from, f)), { mode: 0o600 })
    }
    _dataDir = CANONICAL_DATA_DIR
    return from
  } catch {
    return null // migration is best-effort; the legacy path still resolves and still works
  }
}

function ensureDataDir() {
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 })
  } catch {
    /* best-effort — the write that follows will surface any real problem */
  }
}

const configPath = () => join(dataDir(), "config.json")
const statePath = () => join(dataDir(), "sync-state.json")
const logFilePath = () => join(dataDir(), "sync.log")

function readJsonSafe(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

const loadConfig = () => readJsonSafe(configPath(), null)
// Write-then-rename: `status` or a hook's own read can run concurrently with an in-flight
// background upload's write, and a plain writeFileSync can be read mid-write (a torn read) by
// whoever gets there first. rename() is atomic on the same filesystem, so a reader only ever
// sees the old complete file or the new complete file, never a partial one.
function writeJsonAtomic(path, value, mode) {
  ensureDataDir()
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode })
  renameSync(tmp, path)
}

function saveConfig(cfg) {
  writeJsonAtomic(configPath(), cfg, 0o600)
}

// Two credential lanes now (see the credential section below), so "installed" can no longer
// be spelled `cfg.apiKey`. A config carrying neither is a config that will never upload.
function hasCredential(cfg) {
  return Boolean(cfg?.apiKey || cfg?.oauth?.refreshToken || cfg?.oauth?.accessToken)
}

const loadState = () => readJsonSafe(statePath(), {})
function saveState(state) {
  writeJsonAtomic(statePath(), state, 0o600)
}

// Append-only local log — the only visible trace of what this tool does, since stdout is off
// limits. Never throws: a logging failure must not be the thing that breaks a hook.
async function log(line) {
  try {
    ensureDataDir()
    await appendFile(logFilePath(), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
  } catch {
    /* nothing we can do, and nowhere safe to say so */
  }
}

// BONEZ_SESSION_SYNC=0 disables capture without touching the installed key or config — the
// documented kill switch (SPEC §3.4).
const disabledByEnv = () => process.env.BONEZ_SESSION_SYNC === "0"

function gatewayBaseUrl() {
  if (process.env.BONEZ_GATEWAY_URL) return process.env.BONEZ_GATEWAY_URL.replace(/\/+$/, "")
  const mcpUrl = process.env.BONEZ_MCP_URL
  if (mcpUrl) return mcpUrl.replace(/\/mcp\/?$/, "")
  return "https://gateway.bonez.io"
}

// -------------------------------------------------------------------------------- hook (fast path)

// Reads the hook's stdin JSON synchronously — the same "block until EOF" approach
// hooks/gate-write.sh already uses (`input="$(cat)"`) for the same protocol. Claude Code and
// Codex both write the payload and close the pipe promptly, so this returns quickly; it will
// only hang if invoked interactively with no piped input, which never happens for a real hook.
function readStdinSync() {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

async function cmdHook(agent, event) {
  if (disabledByEnv()) return
  if (agent !== "claude" && agent !== "codex" && agent !== "cursor") return
  if (event !== "session-end" && event !== "session-start") return

  const cfg = loadConfig()
  if (!cfg || !cfg.enabled || !hasCredential(cfg)) return // never installed, or explicitly disabled

  const raw = readStdinSync()
  if (!raw || !raw.trim()) return
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (!payload || typeof payload !== "object") return

  ensureDataDir()
  const payloadFile = join(dataDir(), `.pending-${agent}-${event}-${process.pid}-${Date.now()}.json`)
  try {
    writeFileSync(payloadFile, JSON.stringify(payload))
  } catch {
    return
  }

  // Detach fully: `stdio: "ignore"` cuts every inherited fd loose (stdin/stdout/stderr), which
  // is what lets the parent hook process report "done" immediately instead of the harness
  // waiting on a pipe the child still holds open. `unref()` on top keeps the child from
  // pinning the parent's event loop for the brief window before it exits.
  try {
    const child = spawn(process.execPath, [SELF_PATH, "_upload", agent, event, payloadFile], {
      detached: true,
      stdio: "ignore",
      // On Windows `detached` means "own console", and without this the user gets a console
      // window flashing on screen at the end of EVERY session. Ignored on posix.
      windowsHide: true,
    })
    child.unref()
  } catch {
    try {
      unlinkSync(payloadFile)
    } catch {
      /* ignore */
    }
  }
}

// -------------------------------------------------------------------------------- transcript resolution

// Claude Code's own transcript filenames are `<session_id>.jsonl` under ~/.claude/projects/**
// (parseClaudeFile derives sessionId this same way). Codex rollout files are
// `rollout-<timestamp>-<session_id>.jsonl` under ~/.codex/sessions/YYYY/MM/DD/ — session_id is
// always the trailing segment before `.jsonl`, so a suffix match is exact either way.
function resolveTranscriptPath(agent, sessionId) {
  if (!sessionId) return undefined
  const root =
    agent === "claude"
      ? join(paths.claudeHome, "projects")
      : agent === "cursor"
        ? join(HOME, ".cursor", "projects")
        : join(paths.codexHome, "sessions")
  const hits = walkFiles(root, (p) => p.endsWith(`${sessionId}.jsonl`))
  return hits[0]
}

// The Codex leg's durable fallback (SPEC §3.1): SessionEnd's 3s hard cap plus a session killed
// outright (SIGKILL, crash) can both mean SessionEnd never fires. The following SessionStart
// looks for exactly one other rollout file that isn't already synced and uploads it — "flush
// the previous session" — rather than sweeping the whole ~/.codex/sessions tree on every start
// (that would defeat the one-archive-per-upload design B1 depends on, SPEC §3.5). In the
// common case (SessionEnd fired normally) that file is already in sync-state and this is a
// silent no-op; only a genuinely missed session gets caught, and only one per SessionStart —
// a run of several consecutive crashes needs that many subsequent starts to fully catch up.
function findCodexCatchupTarget(currentSessionId) {
  const sessions = join(paths.codexHome, "sessions")
  const files = walkFiles(sessions, (p) => p.endsWith(".jsonl")).filter((p) => !p.endsWith(`${currentSessionId}.jsonl`))
  const withMtime = files
    .map((p) => {
      try {
        return { p, mtime: statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x) => x !== null)
  withMtime.sort((a, b) => b.mtime - a.mtime)
  const newest = withMtime[0]
  if (!newest) return null
  const sessionId = newest.p.split("/").pop()?.replace(/\.jsonl$/, "") ?? newest.p
  return { sessionId, transcriptPath: newest.p }
}

// Cursor's own SessionStart catch-up — and unlike Codex's, this one is not defensive
// programming against a rare crash. It is the PRIMARY path, because Cursor's sessionEnd
// provably cannot run a command hook in the most common case. Observed in Cursor 3.18.25's
// own hook log:
//
//     Hook step requested: sessionEnd
//     Found 2 hook(s) to execute for step: sessionEnd
//     Running script in directory: /Users/shay/.cursor/plugins/local/bonez
//     STDERR: Error: MainThreadShellExec not initialized
//     ERROR: Error executing hook 2
//
// `reason: "window_close"`: Cursor tears down the shell-exec service before it runs the
// sessionEnd hooks, so EVERY command hook fails — ours and the unrelated PostHog one in the
// same batch. Nothing on our side is wrong (the payload arrives complete, with a populated
// transcript_path and workspace_roots), and nothing on our side can fix it. Closing only the
// chat tab, where the window survives, should still execute — but a capture mechanism that
// silently drops everything whenever someone quits the app is not a mechanism.
//
// So: flush on the NEXT sessionStart instead, from disk. Scoped to the current workspace's
// transcript directory, because that is the one case where the new session's workspace_roots
// is also the right workspace for the old conversation — Cursor's project directories are the
// workspace path with "/" swapped for "-", so the mapping is exact rather than guessed. One
// conversation per start, newest first, skipping anything sync-state already has.
function cursorProjectSlug(workspaceRoot) {
  if (!workspaceRoot) return null
  return workspaceRoot.replace(/^\/+/, "").replace(/\/+$/, "").split("/").join("-")
}

function findCursorCatchupTargets(currentConversationId, workspaceRoot, state) {
  const slug = cursorProjectSlug(workspaceRoot)
  if (!slug) return []
  const root = join(HOME, ".cursor", "projects", slug, "agent-transcripts")
  if (!existsSync(root)) return []
  const files = walkFiles(root, (p) => p.endsWith(".jsonl")).filter(
    (p) => !p.endsWith(`${currentConversationId}.jsonl`),
  )
  const candidates = files
    .map((p) => {
      const id = p.split(/[\\/]/).pop()?.replace(/\.jsonl$/, "") ?? p
      let mtime
      try {
        mtime = statSync(p).mtimeMs
      } catch {
        return null
      }
      const prev = state[id]
      // STALENESS, not "have we ever seen it". Keying on `state[id]` alone — which is what the
      // first cut of this did — permanently blacklists any conversation the moment it is
      // uploaded once. A chat flushed early at 6 messages and then continued to 300 would never
      // be picked up again, because the only thing that could re-upload it is this scan and the
      // scan had already crossed it off. Comparing against the last upload lets a conversation
      // come back as often as it actually changes; uploadOne's own content-hash check then
      // drops the ones where the mtime moved but the content did not.
      if (prev && mtime <= (prev.lastUploadedAt ?? 0)) return null
      return { transcriptPath: p, sessionId: id, mtime }
    })
    .filter((x) => x !== null)
  // Oldest first: a finished conversation should not lose its slot to one that is merely more
  // recently touched. The cap is a runaway guard, not a policy — a workspace with more than
  // this many stale conversations drains over the next few starts.
  candidates.sort((a, b) => a.mtime - b.mtime)
  return candidates.slice(0, CURSOR_CATCHUP_MAX)
}

// ------------------------------------------------------------------- credential (key or OAuth)

// The uploader is a separate OS process from the MCP client, so it cannot borrow the OAuth
// token that client holds (another application's keychain), and even if it could,
// MCP_AUDIENCE_ROUTES pins that token to POST /mcp — not the two import routes this needs.
// So it runs its OWN OAuth: RFC 8628 device flow, whose whole point is that the process
// asking for the token doesn't have to be the process the user authorizes in. Same Auth0,
// same GitHub/Google/whatever sign-in, no console visit and nothing to paste.
//
// A public client, per RFC 8252 §8.5: there is no secret, because a secret shipped inside a
// distributed CLI is not a secret. Security comes from the user's own browser consent and
// from the token being scoped to `bonez:sessions` — upload-only, and refused on /mcp by the
// gateway precisely so a long-lived credential in a config file can't read the org lake.
// `??`, never `||` — the same trap DEBOUNCE_MS documents above. `BONEZ_OAUTH_CLIENT_ID=""`
// is a deliberate "this build has no client", and `||` would treat that empty string as
// unset and fall back to the real one. That is not a style point: with `||`, anything
// setting the variable empty to DISABLE the flow instead starts a real device flow against
// the real Auth0 and polls it for fifteen minutes.
const OAUTH_CLIENT_ID = process.env.BONEZ_OAUTH_CLIENT_ID ?? OAUTH_CLIENT_ID_BUILTIN
const OAUTH_SCOPES = "bonez:sessions offline_access"
// Refresh this far before the token actually expires, so an upload that starts just under the
// wire doesn't 401 midway through presign → PUT → complete.
const TOKEN_SKEW_MS = 120_000
// RFC 8628 §3.5 sets 5s as the default polling interval, and an AS that omits `interval`
// means exactly that — so this is the floor a real login honours. Overridable only so the test
// suite can drive the pending/slow_down branches without spending 5s a poll to do it; same
// escape hatch, and same reason, as BONEZ_SESSION_SYNC_DEBOUNCE_MS above.
const _parsedPollFloor = Number.parseInt(process.env.BONEZ_DEVICE_POLL_FLOOR_MS ?? "", 10)
const DEVICE_POLL_FLOOR_MS = Number.isFinite(_parsedPollFloor) && _parsedPollFloor >= 0 ? _parsedPollFloor : 5_000

async function fetchJson(url, init) {
  const res = await fetch(url, init)
  const text = await res.text().catch(() => "")
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    /* non-JSON body — ok/status and `text` are what callers check */
  }
  return { ok: res.ok, status: res.status, json, text }
}

// Everything about the authorization server is DISCOVERED, never hardcoded: the gateway's
// RFC 9728 metadata names its AS, and that AS's own OIDC metadata names the two endpoints.
// So pointing this at qa (BONEZ_GATEWAY_URL) or at a future tenant needs no code change, and
// the uploader can never end up talking to an AS the resource server doesn't actually trust.
async function discoverAuthServer(gatewayUrl) {
  const prm = await fetchJson(`${gatewayUrl}/.well-known/oauth-protected-resource`)
  if (!prm.ok) throw new Error(`could not read ${gatewayUrl}'s OAuth metadata (HTTP ${prm.status})`)
  const issuer = (prm.json.authorization_servers ?? [])[0]
  const resource = prm.json.resource
  if (!issuer) throw new Error(`${gatewayUrl} names no authorization server — is OAuth configured?`)
  const base = issuer.replace(/\/+$/, "")
  const meta = await fetchJson(`${base}/.well-known/openid-configuration`)
  if (!meta.ok) throw new Error(`could not read ${base}'s OIDC metadata (HTTP ${meta.status})`)
  const deviceEndpoint = meta.json.device_authorization_endpoint
  const tokenEndpoint = meta.json.token_endpoint
  if (!deviceEndpoint || !tokenEndpoint) {
    throw new Error(`${base} does not offer the device-code flow`)
  }
  return { issuer, resource, deviceEndpoint, tokenEndpoint }
}

function formBody(fields) {
  return new URLSearchParams(fields).toString()
}

const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" }

async function deviceLogin(gatewayUrl, { onPrompt = console.log } = {}) {
  if (!OAUTH_CLIENT_ID) {
    throw new Error(
      "OAuth login is not configured in this build.\n" +
        "Use a key instead: bonez-session-sync.mjs install <bnz_...key>\n" +
        "(or set BONEZ_OAUTH_CLIENT_ID if you are testing against your own Auth0 app).",
    )
  }
  const as = await discoverAuthServer(gatewayUrl)
  // `audience` rather than RFC 8707 `resource`: Auth0's device-code endpoint is documented in
  // terms of `audience`, and it is what decides whether the issued token's `aud` is the MCP
  // resource the gateway validates against. `resource` works on /authorize once the tenant's
  // Resource Parameter Compatibility Profile is on; this endpoint is not that endpoint.
  const start = await fetchJson(as.deviceEndpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: formBody({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPES, audience: as.resource }),
  })
  if (!start.ok) {
    throw new Error(`device authorization failed (HTTP ${start.status}): ${start.json.error_description ?? start.text}`)
  }
  const { device_code: deviceCode, user_code: userCode, expires_in: expiresIn } = start.json
  const verifyUrl = start.json.verification_uri_complete || start.json.verification_uri
  onPrompt(
    [
      "",
      "  Open this page to authorize bonez session capture:",
      `    ${verifyUrl}`,
      start.json.verification_uri_complete ? "" : `  and enter the code:  ${userCode}`,
      "",
      `  Waiting for you to approve (this code expires in ${Math.round((expiresIn ?? 900) / 60)} minutes)…`,
      "",
    ]
      .filter((l) => l !== "")
      .join("\n"),
  )

  // RFC 8628 §3.5: poll at the server's `interval`, and back off by 5s more each time it says
  // slow_down. Anything other than the two "keep waiting" errors is terminal — polling through
  // access_denied or expired_token would just burn the user's time to reach the same answer.
  let intervalMs = Math.max((start.json.interval ?? 5) * 1000, DEVICE_POLL_FLOOR_MS)
  const deadline = Date.now() + (expiresIn ?? 900) * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const res = await fetchJson(as.tokenEndpoint, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: OAUTH_CLIENT_ID,
      }),
    })
    if (res.ok && res.json.access_token) return { ...tokensFrom(res.json), issuer: as.issuer }
    const err = res.json.error
    if (err === "authorization_pending") continue
    if (err === "slow_down") {
      intervalMs += 5_000
      continue
    }
    if (err === "access_denied") throw new Error("authorization was denied in the browser")
    if (err === "expired_token") throw new Error("the code expired before it was approved — run login again")
    throw new Error(`token request failed: ${res.json.error_description ?? err ?? `HTTP ${res.status}`}`)
  }
  throw new Error("the code expired before it was approved — run login again")
}

function tokensFrom(payload) {
  return {
    accessToken: payload.access_token,
    // Auth0 only returns this when the client asked for `offline_access` AND the API allows
    // it. Without one, capture would stop working silently the first time the access token
    // expires, so `login` checks for it rather than storing a credential with a fuse in it.
    refreshToken: payload.refresh_token ?? null,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  }
}

async function refreshAccessToken(gatewayUrl, refreshToken) {
  const as = await discoverAuthServer(gatewayUrl)
  const res = await fetchJson(as.tokenEndpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  })
  if (!res.ok || !res.json.access_token) {
    throw new Error(`refresh failed: ${res.json.error_description ?? res.json.error ?? `HTTP ${res.status}`}`)
  }
  // Auth0 rotates refresh tokens when rotation is on and omits the field when it isn't —
  // `?? refreshToken` keeps the existing one in the second case rather than storing null and
  // locking the user out of every future refresh.
  return { ...tokensFrom(res.json), refreshToken: res.json.refresh_token ?? refreshToken }
}

// The one place the upload path asks "what do I authenticate with". Returns a bearer string,
// or throws with a message worth putting in the log. A bnz_ key wins when both are present:
// it is the explicit, headless-lane choice, and it needs no network round trip to use.
async function resolveBearer(cfg, gatewayUrl) {
  if (cfg.apiKey) return cfg.apiKey
  const oauth = cfg.oauth
  if (!oauth?.refreshToken && !oauth?.accessToken) {
    throw new Error("no credential installed — run `login`, or `install <bnz_...key>`")
  }
  if (oauth.accessToken && oauth.expiresAt && Date.now() < oauth.expiresAt - TOKEN_SKEW_MS) {
    return oauth.accessToken
  }
  if (!oauth.refreshToken) {
    throw new Error("the stored access token expired and there is no refresh token — run `login` again")
  }
  const fresh = await refreshAccessToken(gatewayUrl, oauth.refreshToken)
  // Re-read before writing: a concurrent `disable` or `--repo` edit must not be clobbered by
  // an upload that happened to refresh its token at the same moment. Only `oauth` is ours.
  const current = loadConfig() ?? cfg
  saveConfig({ ...current, oauth: { ...fresh, issuer: oauth.issuer } })
  return fresh.accessToken
}

// -------------------------------------------------------------------------------- upload (background)

function httpHeaders(apiKey, extra) {
  return { authorization: `Bearer ${apiKey}`, ...extra }
}

async function presign(gatewayUrl, apiKey, agent, scope) {
  const res = await fetch(`${gatewayUrl}/api/import/presign`, {
    method: "POST",
    headers: httpHeaders(apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ agent, scope }),
  })
  const text = await res.text().catch(() => "")
  let json = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    /* leave json empty; ok/status below is what callers check */
  }
  return { ok: res.ok, status: res.status, json, text }
}

async function putGzip(url, buffer) {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/gzip" },
    body: buffer,
  })
  return { ok: res.ok, status: res.status }
}

async function completeUpload(gatewayUrl, apiKey, uploadId) {
  const res = await fetch(`${gatewayUrl}/api/import/${uploadId}/complete`, {
    method: "POST",
    headers: httpHeaders(apiKey, { "content-type": "application/json" }),
  })
  return { ok: res.ok, status: res.status }
}

// Builds the gzipped-NDJSON bundle the desktop importer's own producer writes
// (packages/desktop/src/main/import/index.ts): one `manifest` line, then one `conversation`
// line. The pipeline's agent-convos adapter only actually reads the `type` discriminator plus
// the per-conversation record's own fields (sessionId/createdAt/updatedAt/workspacePath/
// sourcePath get camelCase→snake_case normalized; agent/title/repo/messages pass through) — the
// manifest's OWN fields aren't parsed by the adapter today (verified against
// bonez-pipeline src/pipeline/adapters/agent_convos.py — `_read_conversations` only branches on
// `rec.get("type") == "conversation"`). Built to match anyway: it's what a human or a future
// consumer sees browsing the archive, and it costs nothing to get right.
// The gateway validates this against its own allow-list (control/import_presign.py `_AGENTS`
// = {"cursor", "claude-code", "codex", "all"}), and the pipeline stores it verbatim on the
// :Convo node. Only the Claude leg's name differs from our internal short name.
const WIRE_AGENT = { claude: "claude-code", codex: "codex", cursor: "cursor" }
function wireAgentFor(agent) {
  return WIRE_AGENT[agent] ?? agent
}

function buildBundle({ agent, scope, repos, conversation, scrubReport }) {
  const manifest = {
    type: "manifest",
    tool: "bonez-session-sync",
    extractedAt: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    agents: [wireAgentFor(agent)],
    scope,
    repos,
    conversationCount: 1,
    messageCount: conversation.messages.length,
    artifactCount: 0,
    scrubReport,
  }
  const ndjson = `${JSON.stringify(manifest)}\n${JSON.stringify({ type: "conversation", ...conversation })}\n`
  return { ndjson, gz: gzipSync(Buffer.from(ndjson, "utf8")) }
}

function contentHashOf(conversation) {
  return createHash("sha256").update(JSON.stringify(conversation.messages)).digest("hex")
}

// The debounce + no-op-if-unchanged guard (SPEC §3.2 step 2). Returns a skip reason string, or
// null if the upload should proceed.
function shouldSkip(state, sessionId, messageCount, contentHash) {
  const prev = state[sessionId]
  if (!prev) return null
  const age = Date.now() - (prev.lastUploadedAt ?? 0)
  if (age < DEBOUNCE_MS) return `inside debounce window (${Math.round(age / 1000)}s < ${Math.round(DEBOUNCE_MS / 1000)}s)`
  if (prev.messageCount === messageCount && prev.contentHash === contentHash) return "unchanged since last upload"
  return null
}

// -------------------------------------------------------------------------------- cursor parsing

// Cursor writes one JSONL transcript per conversation at
// ~/.cursor/projects/<workspace-slug>/agent-transcripts/<conversation_id>/<conversation_id>.jsonl
// and hands the hook its absolute path (`transcript_path`, plus CURSOR_TRANSCRIPT_PATH in the
// environment). The record shape is much thinner than Claude Code's:
//
//     {"role": "user"|"assistant", "message": {"content": [ <block>, ... ]}}
//
// The BLOCKS are Anthropic's own vocabulary — `text` / `tool_use` / `tool_result` — i.e. the
// same set the vendored bundle's claudeContentToMessages already walks. What Cursor omits is
// the per-event envelope Claude Code carries: no `timestamp`, no `cwd`, no `gitBranch`, no
// `uuid`, and no `summary` record to derive a title from. So this cannot simply call
// parseClaudeFile — that reads role from `message.role` (absent here; Cursor puts it on the
// OUTER record), which would silently label every single message "user".
//
// Rather than diverge the vendored bundle (it is re-vendored verbatim from harness-ui — see the
// file header), the walk is reimplemented here against the same output contract, and the
// envelope fields Cursor omits are recovered from the two sources that do have them: the hook
// payload (workspace root) and the file's own mtime/birthtime (timestamps).
//
// Only `tool_result` is untested against a real transcript: across 60 local transcripts Cursor
// emitted `text` and `tool_use` exclusively, never a result block. It is handled anyway — the
// cost is six lines, and the alternative is silently dropping tool output if Cursor starts
// writing it.
function cursorContentToMessages(content, role, scrubber) {
  const msgs = []
  if (typeof content === "string") {
    const t = scrubber.scrubText(content)
    if (t.trim()) msgs.push({ role, text: t })
    return msgs
  }
  if (!Array.isArray(content)) return msgs
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    if (block.type === "text") {
      const t = scrubber.scrubText(block.text ?? "")
      if (t.trim()) msgs.push({ role, text: t })
    } else if (block.type === "tool_use") {
      const input = scrubber.scrubValue(block.input ?? {})
      msgs.push({
        role: "tool",
        tool: block.name ?? "",
        text: JSON.stringify(input).slice(0, 4000),
        toolCallId: block.id || undefined,
        toolInput: input,
      })
    } else if (block.type === "tool_result") {
      const c = scrubber.scrubValue(block.content ?? "")
      msgs.push({
        role: "tool",
        tool: "result",
        text: (typeof c === "string" ? c : JSON.stringify(c)).slice(0, 4000),
        toolResultFor: block.tool_use_id || undefined,
        toolResult: c,
        toolError: block.is_error === true ? true : undefined,
      })
    }
  }
  return msgs
}

// Cursor wraps the human's actual words in `<user_query>...</user_query>` and prepends a
// `<timestamp>` tag (and, when websearch fires, a large `<external_links>` preamble). Titling on
// the raw first block would therefore title most conversations "<timestamp>Tuesday, Sep 1...".
// Pull the query out when the tag is present; fall back to the leading text otherwise.
function cursorTitleFrom(text) {
  const m = /<user_query>([\s\S]*?)<\/user_query>/.exec(text)
  const body = (m ? m[1] : text.replace(/<[^>]+>/g, " ")).trim()
  return body.replace(/\s+/g, " ").slice(0, 120)
}

function parseCursorFile(path, scrubber, repos, scope, cwd) {
  let raw
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return null
  }

  const messages = []
  let title = ""
  for (const line of raw.split("\n")) {
    const s = line.trim()
    if (!s) continue
    let ev
    try {
      ev = JSON.parse(s)
    } catch {
      continue // a transcript being appended to as we read can end mid-line
    }
    if (!ev || typeof ev !== "object") continue
    const msg = ev.message
    const content = msg && typeof msg === "object" ? msg.content : msg
    if (content === undefined || content === null) continue
    // Role lives on the OUTER record. `message.role` is checked first anyway so this keeps
    // working if Cursor moves it inward to match Claude Code's shape.
    const role = (msg && typeof msg === "object" && msg.role) || ev.role || "user"
    for (const m of cursorContentToMessages(content, role, scrubber)) {
      m.cwd = cwd
      messages.push(m)
      if (!title && role === "user" && m.role === "user" && m.text) title = cursorTitleFrom(m.text)
    }
  }
  if (!messages.length) return null
  if (scope === "repo" && !repoFor(cwd, repos)) return null

  // Cursor stamps no timestamps on the records, so the file's own lifetime stands in for the
  // conversation's. birthtime is 0 on filesystems that don't track it — fall back to mtime
  // rather than emitting 1970.
  let createdAt
  let updatedAt
  try {
    const st = statSync(path)
    const born = st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs
    createdAt = new Date(born).toISOString()
    updatedAt = new Date(st.mtimeMs).toISOString()
  } catch {
    /* timestamps are optional in the conversation record */
  }

  return {
    agent: "cursor",
    sessionId: sessionIdFromTranscriptPath(path),
    title,
    workspacePath: cwd,
    repo: repoFor(cwd, repos),
    createdAt,
    updatedAt,
    messages,
    sourcePath: path,
  }
}

// Mirrors the vendored bundle's own sessionIdFromPath (not exported): every agent's transcript
// filename is `<id>.jsonl`, and for Cursor that id is the conversation_id — the stable
// "ID of the conversation across many turns" the hook payload carries, which is exactly the
// unit_key the pipeline MERGEs on.
function sessionIdFromTranscriptPath(p) {
  const leaf = p.split(/[\\/]/).pop() ?? p
  return leaf.replace(/\.jsonl$/, "") || p
}

async function uploadOne({ agent, cfg, sessionId, transcriptPath, cwd }) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    await log(`upload: session=${sessionId} agent=${agent} skipped — transcript not found (${transcriptPath ?? "unresolved"})`)
    return
  }

  const scope = cfg.scope === "global" ? "global" : "repo"
  const repos = scope === "repo" ? normalizeRepos(cfg.repos ?? []) : []
  const scrubber = new Scrubber()
  // Cursor's records carry no cwd of their own, so the workspace root arrives from the hook
  // payload instead and has to be threaded in — hence the separate call rather than one
  // uniform `parse(path, scrubber, repos, scope)`.
  const conversation =
    agent === "cursor"
      ? parseCursorFile(transcriptPath, scrubber, repos, scope, cwd)
      : (agent === "claude" ? parseClaudeFile : parseCodexFile)(transcriptPath, scrubber, repos, scope)
  if (!conversation) {
    await log(
      `upload: session=${sessionId} agent=${agent} skipped — no messages, or outside the configured repo scope`,
    )
    return
  }

  // The local dedup key is the CONVERSATION's own sessionId (parseClaudeFile/parseCodexFile's
  // filename-derived id — for Claude that's the same string as the hook's session_id, since
  // Claude transcript filenames ARE `<session_id>.jsonl`; for Codex it's the whole
  // `rollout-<timestamp>-<session_id>` stem, NOT the bare id the SessionEnd hook payload
  // carries). Keying on the caller-supplied `sessionId` instead would work fine for the normal
  // SessionEnd path, but the SessionStart catch-up path (findCodexCatchupTarget) has no hook-
  // provided id for the OLD session to begin with and can only ever derive this same filename
  // stem — so the two paths would file the same file under two different local keys and never
  // recognize each other's work as "already synced" (the server-side unit_key, which IS this
  // conversation.sessionId, would still MERGE-converge correctly either way; this only affects
  // local bookkeeping, i.e. whether we needlessly re-upload).
  const dedupKey = conversation.sessionId || sessionId
  const messageCount = conversation.messages.length
  const contentHash = contentHashOf(conversation)
  const state = loadState()
  const skipReason = shouldSkip(state, dedupKey, messageCount, contentHash)
  if (skipReason) {
    await log(`upload: session=${dedupKey} agent=${agent} skipped — ${skipReason}`)
    return
  }

  const scrubReport = scrubber.report()
  const { gz } = buildBundle({ agent, scope, repos, conversation, scrubReport })
  const gatewayUrl = gatewayBaseUrl()
  const wireAgent = wireAgentFor(agent)

  let bearer
  try {
    bearer = await resolveBearer(cfg, gatewayUrl)
  } catch (err) {
    await log(`upload: session=${sessionId} agent=${agent} skipped — ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  const pre = await presign(gatewayUrl, bearer, wireAgent, scope)
  if (!pre.ok || !pre.json.upload_id || !pre.json.url) {
    await log(`upload: session=${dedupKey} agent=${agent} presign failed — HTTP ${pre.status}`)
    return
  }

  const put = await putGzip(pre.json.url, gz)
  if (!put.ok) {
    await log(`upload: session=${dedupKey} agent=${agent} PUT failed — HTTP ${put.status}`)
    return
  }

  const done = await completeUpload(gatewayUrl, bearer, pre.json.upload_id)
  if (!done.ok) {
    await log(`upload: session=${dedupKey} agent=${agent} complete failed — HTTP ${done.status}`)
    return
  }

  state[dedupKey] = { agent, messageCount, contentHash, lastUploadedAt: Date.now(), uploadId: pre.json.upload_id }
  saveState(state)
  await log(
    `upload: session=${dedupKey} agent=${agent} messages=${messageCount} redactions=${scrubReport.total} bytes=${gz.length} upload_id=${pre.json.upload_id} OK`,
  )
}

async function cmdUpload(agent, event, payloadFile) {
  let payload
  try {
    payload = JSON.parse(readFileSync(payloadFile, "utf8"))
  } catch (err) {
    await log(`upload: cannot read payload file ${payloadFile}: ${err instanceof Error ? err.message : err}`)
    return
  } finally {
    try {
      unlinkSync(payloadFile)
    } catch {
      /* already gone, or never existed — fine either way */
    }
  }

  if (disabledByEnv()) {
    await log("upload: skipped — BONEZ_SESSION_SYNC=0")
    return
  }
  const cfg = loadConfig()
  if (!cfg || !cfg.enabled || !hasCredential(cfg)) {
    await log("upload: skipped — not installed or disabled")
    return
  }

  if (agent === "cursor" && event === "session-start") {
    const root = workspaceRootFrom(payload)
    // loadState() is re-read inside uploadOne per conversation, so the list is computed once
    // here against a consistent snapshot and each upload then re-checks under its own read.
    const targets = findCursorCatchupTargets(payload.conversation_id ?? payload.session_id ?? "", root, loadState())
    if (!targets.length) {
      await log("upload: cursor session-start — nothing stale in this workspace")
      return
    }
    await log(`upload: cursor session-start — ${targets.length} stale conversation(s) to flush`)
    for (const t of targets) {
      // Sequential, not Promise.all: these share the presign/PUT/complete path and sync-state
      // on disk, and a start hook has no deadline worth racing for.
      await uploadOne({ agent, cfg, sessionId: t.sessionId, transcriptPath: t.transcriptPath, cwd: root })
    }
    return
  }

  if (agent === "codex" && event === "session-start") {
    const target = findCodexCatchupTarget(payload.session_id ?? "")
    if (!target) {
      await log("upload: codex session-start — no other session to catch up")
      return
    }
    await uploadOne({ agent, cfg, sessionId: target.sessionId, transcriptPath: target.transcriptPath })
    return
  }

  // Claude Code and Codex both key on `session_id`. Cursor sends that too, but its transcript
  // is filed under `conversation_id` — "Stable ID of the conversation across many turns" — and
  // the two are not documented to be equal, so the conversation id leads on that leg. It is
  // also the better dedup key regardless: it is what survives a resume.
  const sessionId =
    (agent === "cursor" && typeof payload.conversation_id === "string" ? payload.conversation_id : undefined) ??
    payload.session_id
  if (!sessionId || typeof sessionId !== "string") {
    await log(`upload: ${agent} ${event} skipped — payload has no session_id`)
    return
  }
  let transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path : undefined
  // Cursor exports the same path in the environment; `hook` spawns `_upload` with the inherited
  // env, so it survives the detach. Costs nothing and covers a null/renamed payload field.
  if ((!transcriptPath || !existsSync(transcriptPath)) && agent === "cursor" && process.env.CURSOR_TRANSCRIPT_PATH) {
    transcriptPath = process.env.CURSOR_TRANSCRIPT_PATH
  }
  if (!transcriptPath || !existsSync(transcriptPath)) {
    transcriptPath = resolveTranscriptPath(agent, sessionId)
  }
  await uploadOne({ agent, cfg, sessionId, transcriptPath, cwd: workspaceRootFrom(payload) })
}

// Cursor's transcript records carry no `cwd`, unlike Claude Code's (per-event) and Codex's
// (findCwd over the rollout). Recovering one is not optional, and it matters twice:
//
//   - locally, `scope: "repo"` can never match without it, so a repo-scoped install would
//     upload nothing at all;
//   - server-side, the pipeline's scope routing matches an org scope's repo hints against
//     `workspace_path` + `repo` and drops anything with "no workspace recorded"
//     (bonez-pipeline agent_convos.py `_to_unit`) — so a Cursor conversation with an empty
//     workspacePath would upload cleanly, report OK, and then be silently discarded at ingest.
//     That is the worst failure shape available here: it looks like it works.
//
// The hook payload's
// `workspace_roots` is the replacement; CURSOR_PROJECT_DIR ("Workspace root directory", always
// present per Cursor's hook docs) is the fallback. Entries are documented as paths, but accept
// an object form too rather than stringifying "[object Object]" into workspacePath.
function workspaceRootFrom(payload) {
  const roots = payload?.workspace_roots
  const first = Array.isArray(roots) ? roots[0] : roots
  if (typeof first === "string" && first) return first
  if (first && typeof first === "object") {
    const v = first.path ?? first.uri ?? first.root
    if (typeof v === "string" && v) return v.replace(/^file:\/\//, "")
  }
  return process.env.CURSOR_PROJECT_DIR || undefined
}

// -------------------------------------------------------------------------------- human-facing commands

function parseInstallArgs(rest) {
  const repos = []
  let global = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === "--repo") {
      const value = rest[++i]
      if (value) repos.push(value)
    } else if (arg.startsWith("--repo=")) {
      repos.push(arg.slice("--repo=".length))
    } else if (arg === "--global") {
      global = true
    }
  }
  return { repos, global }
}

// What `status` says about the credential. Never the token, and never the key beyond its
// display prefix — this output routinely ends up pasted into an issue.
function describeCredential(cfg) {
  if (cfg.apiKey) return `API key ${maskKey(cfg.apiKey)}`
  const oauth = cfg.oauth
  if (!oauth) return "(none — run `login`)"
  if (!oauth.expiresAt) return "OAuth"
  const mins = Math.round((oauth.expiresAt - Date.now()) / 60_000)
  const freshness = mins > 0 ? `token valid ${mins}m` : "token expired, refreshes on next upload"
  return `OAuth${oauth.refreshToken ? "" : " (no refresh token)"} — ${freshness}`
}

function maskKey(key) {
  if (!key) return "(none)"
  return key.length <= 10 ? "****" : `${key.slice(0, 10)}${"*".repeat(Math.min(24, key.length - 10))}`
}

function consentText(cfg) {
  const scopeDetail =
    cfg.scope === "global"
      ? "ALL repos this machine ever touches (global capture)."
      : (cfg.repos ?? []).length
        ? `only these repos:\n${cfg.repos.map((r) => `    - ${r}`).join("\n")}`
        : "no repos yet — nothing will upload until you add one (see --repo)."
  return [
    "bonez session capture: installed and ENABLED.",
    "",
    "What uploads: your Claude Code and Codex conversation transcripts, at the end of each",
    "matching session. Secrets are scrubbed on-device (API keys, tokens, private keys,",
    "passwords, connection strings) BEFORE anything leaves this machine — the same scrub pass",
    "the desktop app's manual importer uses (@bonez/agent-import).",
    "",
    `Scope: ${scopeDetail}`,
    "",
    `Where it goes: ${gatewayBaseUrl()} → your org's bonez import pipeline → the org knowledge`,
    "graph, as a searchable :Convo (same destination as the desktop app's manual import).",
    "",
    "Who can read it: anyone in your org with bonez read/session access — the same visibility",
    "as any other imported conversation. Content you scrub locally never leaves this machine.",
    "",
    "This now runs automatically, unattended, at the end of every matching session.",
    "  Turn off without uninstalling:  BONEZ_SESSION_SYNC=0",
    "  Turn off persistently:          bonez-session-sync.mjs disable",
    "  Check status any time:          bonez-session-sync.mjs status",
    `Credential stored at: ${configPath()} (${credentialProtection()}).`,
    cfg.oauth
      ? "Signed in with OAuth, scoped to session upload only — this credential cannot read the lake."
      : "Using an API key. `login` swaps it for browser sign-in with no key on disk.",
  ].join("\n")
}

function cmdInstall(key, rest) {
  reportMigration()
  if (!key || !key.startsWith("bnz_")) {
    console.error("usage: bonez-session-sync.mjs install <bnz_...key> [--repo <path>]... [--global]")
    console.error("  Mint a sessions-scoped key in console.bonez.io under API keys, scope = sessions.")
    process.exitCode = 1
    return
  }
  const { repos: explicitRepos, global } = parseInstallArgs(rest)
  const scope = global ? "global" : "repo"
  const repos = global ? [] : normalizeRepos(explicitRepos.length ? explicitRepos : [process.cwd()])
  const cfg = { enabled: true, apiKey: key, scope, repos, installedAt: new Date().toISOString() }
  saveConfig(cfg)
  console.log(consentText(cfg))
}

async function cmdLogin(rest) {
  reportMigration()
  const { repos: explicitRepos, global } = parseInstallArgs(rest)
  const scope = global ? "global" : "repo"
  const repos = global ? [] : normalizeRepos(explicitRepos.length ? explicitRepos : [process.cwd()])
  let tokens
  try {
    tokens = await deviceLogin(gatewayBaseUrl())
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }
  if (!tokens.refreshToken) {
    // Without one, capture works until the access token expires and then stops — silently,
    // in a background process nobody is watching. Refuse now, loudly, rather than install a
    // credential with a fuse in it.
    console.error(
      "Authorization succeeded but no refresh token was issued, so capture would stop working\n" +
        "within the hour. Enable offline access for this application/API in Auth0, then run login again.",
    )
    process.exitCode = 1
    return
  }
  // Preserve an existing install's fields (enabled/installedAt) so `login` can also be used to
  // re-authorize an install that already exists, without resetting it.
  const current = loadConfig() ?? {}
  const cfg = {
    ...current,
    enabled: true,
    scope,
    repos,
    oauth: tokens,
    installedAt: current.installedAt ?? new Date().toISOString(),
  }
  delete cfg.apiKey
  saveConfig(cfg)
  console.log(consentText(cfg))
}

function cmdLogout() {
  const cfg = loadConfig()
  if (!cfg) {
    console.log("bonez session capture: not installed — nothing to log out of.")
    return
  }
  delete cfg.oauth
  delete cfg.apiKey
  cfg.enabled = false
  saveConfig(cfg)
  console.log("bonez session capture: credential removed and capture disabled. Run `login` to set it up again.")
}

function cmdStatus() {
  reportMigration()
  const cfg = loadConfig()
  if (!cfg) {
    console.log("bonez session capture: not installed.")
    console.log("Run: bonez-session-sync.mjs login [--repo <path>]... [--global]")
    console.log("  (headless, no browser: install <bnz_...key> with the same options)")
    return
  }
  const state = loadState()
  const lines = [
    `bonez session capture: ${cfg.enabled ? "enabled" : "disabled"}${
      disabledByEnv() ? " (env override BONEZ_SESSION_SYNC=0 is ALSO active)" : ""
    }`,
    `  sign-in:  ${describeCredential(cfg)}`,
    `  scope:    ${cfg.scope}`,
  ]
  if (cfg.scope === "repo") {
    if ((cfg.repos ?? []).length) for (const r of cfg.repos) lines.push(`              - ${r}`)
    else lines.push("              (none — nothing will upload until you add one)")
  }
  lines.push(
    `  gateway:  ${gatewayBaseUrl()}`,
    `  clients:  Claude Code, Codex, Cursor (one sign-in, shared store)`,
    `  sessions synced: ${Object.keys(state).length}`,
    `  installed:${cfg.installedAt ?? "unknown"}`,
    `  data dir: ${dataDir()}`,
    `  log:      ${logFilePath()}`,
  )
  console.log(lines.join("\n"))
}

function cmdDisable() {
  const cfg = loadConfig()
  if (!cfg) {
    console.log("bonez session capture: not installed — nothing to disable.")
    return
  }
  cfg.enabled = false
  saveConfig(cfg)
  console.log("bonez session capture: disabled. The key is kept — re-enable with `bonez-session-sync.mjs enable`.")
}

function cmdEnable() {
  const cfg = loadConfig()
  if (!cfg) {
    console.log("bonez session capture: not installed. Run `bonez-session-sync.mjs install <key>` first.")
    return
  }
  cfg.enabled = true
  saveConfig(cfg)
  console.log("bonez session capture: enabled.")
}

// -------------------------------------------------------------------------------- entrypoint

async function main() {
  const [, , cmd, ...rest] = process.argv
  switch (cmd) {
    case "hook":
      // Total safety net: whatever goes wrong here must never surface to the harness.
      try {
        await cmdHook(rest[0], rest[1])
      } catch {
        /* a hook that fails loudly is worse than a hook that silently did nothing */
      }
      // fetch's keep-alive connection pool (undici) can hold an idle socket open well past
      // when our own work is done, which would otherwise keep this process's event loop alive
      // for several more seconds. Nothing after this point has anything left to flush — stdout
      // is never written on this path — so exit immediately instead of waiting that out. This
      // matters most for `hook`, which the detaching parent already returned from by the time
      // its own spawn() call resolved; `_upload` is a detached child so nobody is waiting on
      // it either way, but exiting promptly is still the tidier default.
      process.exit(0)
      break
    case "_upload":
      try {
        await cmdUpload(rest[0], rest[1], rest[2])
      } catch (err) {
        await log(`upload: uncaught error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      }
      process.exit(0)
      break
    case "login":
      await cmdLogin(rest)
      return
    case "logout":
      cmdLogout()
      return
    case "install":
      cmdInstall(rest[0], rest.slice(1))
      return
    case "status":
      cmdStatus()
      return
    case "disable":
      cmdDisable()
      return
    case "enable":
      cmdEnable()
      return
    default:
      console.log("bonez-session-sync — capture Claude Code / Codex sessions into bonez")
      console.log("")
      console.log("usage:")
      console.log("  bonez-session-sync.mjs login [--repo <path>]... [--global]     browser sign-in")
      console.log("  bonez-session-sync.mjs logout")
      console.log("  bonez-session-sync.mjs install <bnz_...key> [--repo <path>]... [--global]")
      console.log("                                                                  headless lane")
      console.log("  bonez-session-sync.mjs status")
      console.log("  bonez-session-sync.mjs disable")
      console.log("  bonez-session-sync.mjs enable")
      process.exitCode = cmd ? 1 : 0
  }
}

// Only dispatch when this file is run directly (`node bin/bonez-session-sync.mjs ...`), not
// when a test imports it as an ES module to unit-test the pure helpers below.
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`
  } catch {
    return false
  }
})()
if (isMain) await main()

export {
  buildBundle,
  cmdHook,
  cursorTitleFrom,
  describeCredential,
  discoverAuthServer,
  hasCredential,
  resolveBearer,
  cmdUpload,
  contentHashOf,
  dataDir,
  migrateLegacyData,
  findCodexCatchupTarget,
  findCursorCatchupTargets,
  cursorProjectSlug,
  gatewayBaseUrl,
  parseCursorFile,
  resolveTranscriptPath,
  wireAgentFor,
  workspaceRootFrom,
  shouldSkip,
}
