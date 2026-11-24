#!/usr/bin/env node
// bonez-session-sync — captures Claude Code, Codex and Cursor conversation transcripts at
// session end
// and uploads them into the org's bonez System Model, the same pipeline the desktop app's
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
// Vendors @bonez/agent-import's prebuilt bundle verbatim from bonez-io/bonez-core
// (libs/agent-import/bundle/agent-import.bundle.mjs, commit 7dbcbb44e) at
// bin/vendor/agent-import.bundle.mjs — Node builtins only, no npm install needed.
// Do not hand-edit that file; re-vendor it verbatim when that library's source changes.
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { appendFile } from "node:fs/promises"
import { hostname, homedir, platform, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import zlib, { gzipSync } from "node:zlib"
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
import { git, originRepo } from "./lib/git.mjs"
import { applyPatchFiles } from "./lib/apply-patch.mjs"

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

// Same reasoning for the Claude leg, but smaller: SessionStart runs on a hook budget while
// someone is waiting to type, and unlike Cursor's window_close problem a missed Claude
// SessionEnd is the exception rather than the rule. Five drains a crash or two without making
// the start of a session feel like it stalled; `backfill` exists for real volume.
const CLAUDE_CATCHUP_MAX = 5

// A transcript written within this long is probably a session still running (people run several
// at once in one workspace). It is not a catch-up or backfill candidate: its own SessionEnd sends
// it, or a later start once it has gone quiet. Ten minutes: long enough that an active session
// is not caught between turns, short enough that one left open but idle is captured the same
// hour. Without it, newest-first would spend every start re-uploading the live sessions.
// Overridable only so the test suite can flush transcripts it just wrote, as with the debounce.
const _parsedQuietMs = Number.parseInt(process.env.BONEZ_SESSION_SYNC_QUIET_MS ?? "", 10)
const CATCHUP_QUIET_MS = Number.isFinite(_parsedQuietMs) && _parsedQuietMs >= 0 ? _parsedQuietMs : 10 * 60_000

// `backfill` is a human sweeping YEARS of local history, not a hook. It still runs in bounded
// batches so it can be interrupted and resumed rather than becoming one unkillable upload
// storm — each batch leaves sync-state consistent, so re-running continues where it stopped.
const CLAUDE_BACKFILL_BATCH = 25

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
  return (_dataDir ??= resolveDataDir(process.env.CLAUDE_PLUGIN_DATA))
}

// Which folder a hook started with `hostDir` as its CLAUDE_PLUGIN_DATA reads. `status` calls it
// with the folder the Claude Code hook last reported, so it answers for the hook from any shell.
function resolveDataDir(hostDir) {
  // An explicit override always wins — tests rely on this, and it is the escape hatch for
  // anyone with an unusual layout.
  const explicit = process.env.BONEZ_SESSION_SYNC_DATA
  if (explicit) return explicit
  // Preserve a host-specific choice (including disabled), but an empty host-created
  // directory must not hide a configured shared store.
  if (hostDir && existsSync(join(hostDir, "config.json"))) return hostDir
  if (existsSync(join(CANONICAL_DATA_DIR, "config.json"))) return CANONICAL_DATA_DIR
  if (hostDir) return hostDir
  for (const d of legacyDataDirs()) {
    if (existsSync(join(d, "config.json"))) return d
  }
  return CANONICAL_DATA_DIR
}

// The Claude Code hook writes down its host folder, so `status` from a plain shell (where
// CLAUDE_PLUGIN_DATA is not set) can answer for the folder the hook really reads.
const hookFolderPath = () => join(CANONICAL_DATA_DIR, "hook-folder.json")
function rememberHookFolder() {
  const hostDir = process.env.CLAUDE_PLUGIN_DATA
  // The server address too: the plugin option is only in the hooks' environment.
  const seen = readJsonSafe(hookFolderPath(), null)
  if (!hostDir || (seen?.claude === hostDir && seen?.gateway === gatewayBaseUrl())) return
  // Only for someone who set capture up: settings exist somewhere.
  if (![hostDir, CANONICAL_DATA_DIR, ...legacyDataDirs()].some((d) => existsSync(join(d, "config.json")))) return
  try {
    mkdirSync(CANONICAL_DATA_DIR, { recursive: true, mode: 0o700 })
    copyAtomic(`${JSON.stringify({ claude: hostDir, gateway: gatewayBaseUrl(), gatewaySource: gatewaySource() })}\n`, hookFolderPath())
  } catch {
    /* status then answers for this shell's own resolution */
  }
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
  // An empty host folder is not a choice: migrate past it, so `status` does the same under the
  // hook's environment as in a plain shell.
  const hostDir = process.env.CLAUDE_PLUGIN_DATA
  if (process.env.BONEZ_SESSION_SYNC_DATA || (hostDir && existsSync(join(hostDir, "config.json")))) return null
  if (existsSync(join(CANONICAL_DATA_DIR, "config.json"))) return null
  const from = legacyDataDirs().find((d) => existsSync(join(d, "config.json")))
  if (!from || from === CANONICAL_DATA_DIR) return null
  try {
    mkdirSync(CANONICAL_DATA_DIR, { recursive: true, mode: 0o700 })
    // State first, config last: the config is what makes the folder count, so a crash in between
    // never leaves a config without its record of what already uploaded.
    for (const f of ["sync-state.json", "config.json"]) {
      if (existsSync(join(from, f))) copyAtomic(readFileSync(join(from, f)), join(CANONICAL_DATA_DIR, f))
    }
    _dataDir = CANONICAL_DATA_DIR
    return from
  } catch {
    return null // migration is best-effort; the legacy path still resolves and still works
  }
}

function copyAtomic(data, path) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
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

// sync-state keys a Codex session by its UUID (1SI-4111). Older plugins keyed an upload by the
// rollout stem `rollout-<ts>-<uuid>` while backfill and its counts used the UUID, so one session
// could be listed, counted and sent twice. Those keys are moved to the UUID on read (the newer
// entry wins when both exist); the next write saves the result.
const ROLLOUT_KEY_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
function migrateStateKeys(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  for (const key of Object.keys(state)) {
    const uuid = ROLLOUT_KEY_RE.exec(key)?.[1]
    if (!uuid || (state[key]?.agent && state[key].agent !== "codex")) continue
    const entry = state[key]
    delete state[key]
    if (!state[uuid] || (state[uuid].lastUploadedAt ?? 0) < (entry?.lastUploadedAt ?? 0)) state[uuid] = entry
  }
  return state
}
const loadState = () => migrateStateKeys(readJsonSafe(statePath(), {}))
function saveState(state) {
  writeJsonAtomic(statePath(), state, 0o600)
}

// Concurrent chats mean concurrent UPLOADERS. Cursor's `stop` fires per conversation, so
// three open chats produce three detached processes that each load sync-state, add their own
// entry, and write it back. writeJsonAtomic makes each individual write atomic — no torn
// file — but the read-modify-write ACROSS processes is not, so the last writer silently drops
// the other two entries. (Measured: three interleaved uploads, one entry survived.)
//
// The damage is not lost conversations — unit_key MERGEs server-side, so the System Model is
// unaffected — but a dropped entry means the next trigger sees the conversation as never
// uploaded and uploads it again. That defeats the debounce, which exists specifically to keep
// upload count down, which is the whole reason `stop` is affordable.
//
// A lockfile rather than one-file-per-conversation: `status`, the debounce and the catch-up
// scan all read the whole map, and keeping one file keeps those simple.
const STATE_LOCK_TIMEOUT_MS = 5_000
const STATE_LOCK_STALE_MS = 30_000

function sleepSync(ms) {
  // The uploader is a detached background process with no event loop obligations, so
  // blocking is fine here — and Atomics.wait is the only way to sleep synchronously without
  // a busy loop that would burn CPU while the other uploader finishes.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      /* SharedArrayBuffer unavailable — spin, briefly */
    }
  }
}

function withStateLock(fn, timeoutMs = STATE_LOCK_TIMEOUT_MS) {
  const lock = `${statePath()}.lock`
  const held = takeStateLock(lock, timeoutMs)
  try {
    return fn()
  } finally {
    releaseStateLock(lock, held)
  }
}

// The same lock around async work (the token refresh, which waits on the network).
async function withStateLockAsync(fn, timeoutMs = STATE_LOCK_TIMEOUT_MS) {
  const lock = `${statePath()}.lock`
  const held = takeStateLock(lock, timeoutMs)
  try {
    return await fn()
  } finally {
    releaseStateLock(lock, held)
  }
}

function takeStateLock(lock, timeoutMs) {
  ensureDataDir()
  const deadline = Date.now() + timeoutMs
  let held = false
  for (;;) {
    try {
      closeSync(openSync(lock, "wx")) // 'wx' fails if it exists — the atomic bit
      held = true
      break
    } catch {
      // A crashed uploader must never deadlock every future one.
      try {
        if (Date.now() - statSync(lock).mtimeMs > STATE_LOCK_STALE_MS) {
          unlinkSync(lock)
          continue
        }
      } catch {
        continue // vanished between our open and our stat — try again immediately
      }
      if (Date.now() > deadline) break // proceed unlocked: a stale entry beats never recording
      sleepSync(25)
    }
  }
  return held
}

function releaseStateLock(lock, held) {
  if (!held) return
  try {
    unlinkSync(lock)
  } catch {
    /* already gone */
  }
}

// Record one conversation's result without clobbering entries another uploader wrote while
// this one was busy. The re-read INSIDE the lock is the point — reusing the snapshot taken
// before the upload would reintroduce exactly the race the lock closes.
function recordUpload(sessionId, entry) {
  withStateLock(() => {
    const fresh = loadState()
    fresh[sessionId] = entry
    saveState(fresh)
  })
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

// Where the server address came from, in the order gatewayBaseUrl reads them.
function gatewaySource() {
  if (process.env.CLAUDE_PLUGIN_OPTION_BONEZ_URL) return "the plugin's server address option"
  if (process.env.BONEZ_GATEWAY_URL) return "BONEZ_GATEWAY_URL"
  if (process.env.BONEZ_MCP_URL) return "BONEZ_MCP_URL"
  if (gatewayBaseUrl() !== "https://gateway.bonez.io") return "the setup page you paired with"
  return "the default"
}

// The gateway host a stored OAuth sign-in was issued for: recorded at sign-in, or, for a sign-in
// from before that, the host of the token's MCP audience (`https://<gateway>/mcp`). Undefined for
// an API key or when it cannot be told; then nothing is compared. Reads claims only, never logs them.
function signInHost(cfg) {
  const oauth = cfg?.apiKey ? undefined : cfg?.oauth
  if (!oauth) return undefined
  try {
    if (oauth.gateway) return new URL(oauth.gateway).host
    const claims = JSON.parse(Buffer.from(String(oauth.accessToken).split(".")[1], "base64url").toString("utf8"))
    const mcp = [].concat(claims.aud ?? []).find((a) => typeof a === "string" && /^https?:\/\/[^/]+\/mcp\/?$/.test(a))
    return mcp ? new URL(mcp).host : undefined
  } catch {
    return undefined
  }
}

// A sign-in issued by one gateway is refused by another, so nothing is sent and the person is told.
function signInMismatch(cfg, gatewayUrl) {
  const signedIn = signInHost(cfg)
  let target
  try {
    target = new URL(gatewayUrl).host
  } catch {
    return undefined
  }
  return signedIn && signedIn !== target ? { signedIn, target } : undefined
}
const mismatchText = (m) =>
  `Bonez session capture is signed in to ${m.signedIn}, but the plugin's server address is ${m.target}, so nothing uploads. Sign in again (\`node "${SELF_PATH}" login\`) or change the plugin's server address.`

function gatewayBaseUrl() {
  const hostOption = process.env.CLAUDE_PLUGIN_OPTION_BONEZ_URL
  if (hostOption) return hostOption.replace(/\/+$/, "")
  if (process.env.BONEZ_GATEWAY_URL) return process.env.BONEZ_GATEWAY_URL.replace(/\/+$/, "")
  const mcpUrl = process.env.BONEZ_MCP_URL
  if (mcpUrl) return mcpUrl.replace(/\/mcp\/?$/, "")
  // The gateway `connect` paired with (1SI-4098): its key is only good there. Codex and Cursor hooks have no
  // plugin option naming the server, so without this a key from qa (or a local lab) would go to the default.
  // Resolved without `dataDir()`, whose answer is cached for the process on first use.
  const paired = readJsonSafe(join(resolveDataDir(process.env.CLAUDE_PLUGIN_DATA), "config.json"), {})?.gateway
  if (typeof paired === "string" && captureGatewayAllowed(paired)) return paired.replace(/\/+$/, "")
  return "https://gateway.bonez.io"
}

// Session capture signs in against Bonez's OWN identity provider and uploads to Bonez's OWN
// import pipeline, so it is only for Bonez-operated gateways. A customer's Bonez server is a
// different tenant, and a developer's transcripts must never land in ours by accident because
// the plugin happens to point somewhere else. `login` and `install` therefore refuse any other
// host. Loopback is allowed so a local gateway (and this repo's stub-gateway tests) still work.
const OUR_GATEWAY_HOSTS = new Set(["gateway.bonez.io", "qa.gateway.bonez.io", "localhost", "127.0.0.1", "[::1]"])

function captureGatewayAllowed(base) {
  try {
    const url = new URL(base)
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    return !url.username && !url.password && OUR_GATEWAY_HOSTS.has(url.hostname) &&
      (url.protocol === "https:" || (local && url.protocol === "http:"))
  } catch {
    return false
  }
}

// Returns true (after saying why on stderr) when the configured gateway is not one of ours.
function refuseForeignGateway(command) {
  const base = gatewayBaseUrl()
  if (captureGatewayAllowed(base)) return false
  let host = "unparseable"
  try { host = new URL(base).hostname } catch { /* omit malformed URL */ }
  console.error(
    `bonez session capture: refusing \`${command}\` — the configured Bonez URL (${host || "unparseable"}) is not a\n` +
      "Bonez-operated gateway (gateway.bonez.io, qa.gateway.bonez.io). Session capture signs in to Bonez's own\n" +
      "identity provider and uploads to Bonez's own pipeline, so it is not for a customer's Bonez server.\n" +
      "If BONEZ_GATEWAY_URL or BONEZ_MCP_URL is set by mistake, unset it.",
  )
  process.exitCode = 1
  return true
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
  if (event !== "session-end" && event !== "session-start" && event !== "turn-end" && event !== "tool-use") return

  const claudeStart = agent === "claude" && event === "session-start"
  if (claudeStart) rememberHookFolder()
  // A setup answered in the browser after its terminal closed is finished here (1SI-4098).
  if (event === "session-start") {
    try {
      await collectPendingAtStart()
    } catch {
      /* silent: the next start asks again */
    }
  }
  const cfg = loadConfig()
  if (!cfg || !cfg.enabled || !hasCredential(cfg)) {
    // never installed, or explicitly disabled. Settings left in a folder the hook no longer
    // reads are neither: say so, once a day.
    if (claudeStart && !cfg && strandedSettings().length) notifyOnce("stranded", "Bonez session capture is set up, but its settings are in an older folder this plugin no longer reads, so nothing uploads.")
    // Never set up on this machine: open the setup page once, then offer it on later starts
    // (1SI-4098). A config that exists but is off is a choice someone made, and is left alone.
    // A setup still waiting for its answer in the browser is not offered again.
    else if (!cfg && event === "session-start" && !readPending() && !(await openConnectOnce(agent))) await offerCapture(agent)
    return
  }

  const raw = readStdinSync()
  if (!raw || !raw.trim()) return
  if (event === "session-start" && announceEnabled(agent)) {
    /* the one "capture is on" line after a yes from the offer; nothing else this start */
  } else if (claudeStart) {
    const notice = captureNotice(cfg)
    if (notice) notifyOnce(notice.reason, notice.text)
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (!payload || typeof payload !== "object") return
  if (event === "tool-use") return recordTouch(agent, payload)

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
  if (!spawnWorker(["_upload", agent, event, payloadFile])) {
    try {
      unlinkSync(payloadFile)
    } catch {
      /* ignore */
    }
  }
  // The upload ends the session for teammates; its presence is no longer needed.
  const id = liveSessionId(agent, payload)
  if (event === "session-end" && typeof id === "string" && SESSION_ID_RE.test(id)) forgetPresence(id)
}

function spawnWorker(args) {
  try {
    const child = spawn(process.execPath, [SELF_PATH, ...args], {
      detached: true,
      stdio: "ignore",
      // On Windows `detached` means "own console", and without this the user gets a console
      // window flashing on screen at the end of EVERY session. Ignored on posix.
      windowsHide: true,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}

// -------------------------------------------------------------------------------- transcript resolution

// Claude Code's own transcript filenames are `<session_id>.jsonl` under ~/.claude/projects/**
// (parseClaudeFile derives sessionId this same way). Codex rollout files are
// `rollout-<timestamp>-<session_id>.jsonl` under ~/.codex/sessions/YYYY/MM/DD/ — session_id is
// always the trailing segment before `.jsonl`, so a suffix match is exact either way. Codex also
// compresses older ones and moves archived ones (codexRollouts), and those are found too.
function resolveTranscriptPath(agent, sessionId) {
  if (!sessionId) return undefined
  if (agent === "codex") return codexRollouts().find((p) => transcriptId(p).endsWith(sessionId))
  const root =
    agent === "claude"
      ? join(paths.claudeHome, "projects")
      : join(HOME, ".cursor", "projects")
  const hits = walkFiles(root, (p) => p.endsWith(`${sessionId}.jsonl`))
  return hits[0]
}

// -------------------------------------------------------------------------------- codex rollouts
//
// Codex keeps a thread's rollout at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl. A
// background worker compresses rollouts older than seven days to `….jsonl.zst` (zstd), and an
// archived thread moves to $CODEX_HOME/archived_sessions/ (codex-rs/rollout/src/compression.rs).
// On a real Mac 1,087 of 1,118 rollouts were compressed, so reading only plain files under
// sessions/ missed almost all history. Node reads zstd from 22.15 (zlib.zstdDecompressSync); on an
// older Node the compressed ones are left alone and `backfill` and `status` say how many.
const codexHome = () => process.env.CODEX_HOME || paths.codexHome
const CODEX_ROLLOUT_RE = /(?:^|[\\/])rollout-[^\\/]*\.jsonl(?:\.zst)?$/
// BONEZ_SESSION_SYNC_NO_ZSTD=1 stands in for an older Node, for the tests.
const zstdDecompress = process.env.BONEZ_SESSION_SYNC_NO_ZSTD === "1" ? undefined : zlib.zstdDecompressSync
const isZst = (p) => p.endsWith(".zst")
const ZSTD_NEEDED = "Node 22.15 or later"

// Every rollout on this machine, plain and compressed, live and archived. When a rollout exists both
// ways (Codex is compressing it right now), the plain one is used.
function codexRollouts() {
  const all = [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")].flatMap((root) =>
    walkFiles(root, (p) => CODEX_ROLLOUT_RE.test(p)),
  )
  const plain = new Set(all.filter((p) => !isZst(p)).map(transcriptId))
  return all.filter((p) => !isZst(p) || !plain.has(transcriptId(p)))
}

// How many compressed rollouts this Node cannot read: 0 when it can.
function unreadableCodexRollouts() {
  return zstdDecompress ? 0 : codexRollouts().filter(isZst).length
}
function zstdNotice(n) {
  return `${n} older Codex session${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} ${ZSTD_NEEDED} to be read (this is Node ${process.versions.node}).`
}

// Codex has added line shapes the vendored parser predates: an `ordinal` on every line, and
// `token_usage_record`, `world_state` and `event_msg` (`item_completed`, `token_count`, …) lines.
// None of them is conversation the parser keeps: the messages and tool calls are the
// `response_item` lines. So those lines are reduced to their timestamp (the session's last
// activity), and a tool output Codex now writes as a list of content parts is joined into the
// text the parser expects. Anything else passes through as it was.
const CODEX_SKIPPED_LINES = new Set(["token_usage_record", "world_state", "event_msg"])
function normalizeCodexLine(line) {
  let ev
  try {
    ev = JSON.parse(line)
  } catch {
    return null // a rollout being appended to can end mid-line
  }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return null
  if (CODEX_SKIPPED_LINES.has(ev.type)) return typeof ev.timestamp === "string" ? JSON.stringify({ timestamp: ev.timestamp }) : null
  const out = ev.payload?.output
  if (Array.isArray(out) && /_call_output$/.test(String(ev.payload.type))) {
    const text = out.map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n")
    return JSON.stringify({ ...ev, payload: { ...ev.payload, output: text } })
  }
  return line
}

// Parses one rollout, plain or compressed, through the vendored parser. The uploaded conversation
// keeps the id the server has always filed it under, the file's stem `rollout-<ts>-<uuid>` (see
// uploadOne for why that id stays). Returns { conversation } or { skipped: reason }.
function parseCodexRollout(path, scrubber, repos, scope) {
  let text
  try {
    const raw = readFileSync(path)
    if (isZst(path)) {
      if (!zstdDecompress) return { skipped: `a compressed Codex session, which needs ${ZSTD_NEEDED}` }
      text = zstdDecompress(raw).toString("utf8")
    } else {
      text = raw.toString("utf8")
    }
  } catch (err) {
    return { skipped: `unreadable (${err instanceof Error ? err.message : String(err)})` }
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean).map(normalizeCodexLine).filter((l) => l !== null)
  // The vendored parser reads a file by path and names the session after it, so it gets one, with
  // the rollout's own name, in a folder only this user can read, removed straight after.
  const dir = mkdtempSync(join(tmpdir(), "bonez-codex-"))
  try {
    const copy = join(dir, `${transcriptId(path)}.jsonl`)
    writeFileSync(copy, `${lines.join("\n")}\n`, { mode: 0o600 })
    const conversation = parseCodexFile(copy, scrubber, repos, scope)
    return conversation ? { conversation: { ...conversation, sourcePath: path } } : { skipped: "no messages, or outside the configured repo scope" }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
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
  const files = codexRollouts().filter((p) => !transcriptId(p).endsWith(currentSessionId) && (zstdDecompress || !isZst(p)))
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
  // The rollout's UUID, the `session_id` its own SessionEnd uploads under (1SI-4098).
  return { sessionId: codexTranscriptId(newest.p), transcriptPath: newest.p }
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
// is also the right workspace for the old conversation. One conversation per start, newest first,
// skipping anything sync-state already has.
//
// Cursor names a project directory after the workspace path with every run of characters other than
// ASCII letters and digits turned into one "-", and none at either end; case is kept. Checked against
// every workspace Cursor recorded on a real Mac (workspaceStorage/*/workspace.json against
// ~/.cursor/projects, 36 of 36): `/Users/me/Library/Application Support/Cursor/Workspaces/17719/workspace.json`
// is `Users-me-Library-Application-Support-Cursor-Workspaces-17719-workspace-json`, `/Users/me/.bonez/a/ses_1`
// is `Users-me-bonez-a-ses-1`. Mapping only "/" missed 7 of them. Lossy like Claude's, so it maps path to
// directory only. A Windows root (`c:\Users\me\proj`, `/c:/Users/me/proj`) comes out `c-Users-me-proj` by the
// same rule (unverified on Windows; its file system is case-insensitive, so the drive letter's case does not
// matter). Non-ASCII letters are assumed to map like punctuation (not seen yet).
function cursorProjectSlug(workspaceRoot) {
  if (!workspaceRoot) return null
  return workspaceRoot.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || null
}

// A path from a Windows machine: a drive letter (`C:\x`, `C:/x`, `/c:/x`) or a UNC share. Told apart
// by shape, not by process.platform, so POSIX paths keep their exact old behaviour and the Windows
// branches are testable anywhere. (A POSIX directory whose first segment looks like `c:` is not a case.)
function isWindowsPath(p) {
  return /^\/?[A-Za-z]:([\\/]|$)/.test(p) || p.startsWith("\\\\")
}

// A sub-agent's transcript is part of its lead session, never a session of its own. Claude Code
// files it under <session>/subagents/ and marks every one of its lines `"isSidechain":true`, so
// either says so. Cursor files it under agent-transcripts/<conversation>/subagents/<id>.jsonl, with
// no marker in the lines, so the folder is what says so there. Only the head is read: the marker
// sits near the start of every record. (A key inside a message's text is escaped,
// `\"isSidechain\":`, so it cannot match.)
function isSidechainTranscript(path) {
  if (path.split(/[\\/]/).slice(0, -1).includes("subagents")) return true
  let fd
  try {
    fd = openSync(path, "r")
    const head = Buffer.alloc(16_384)
    const n = readSync(fd, head, 0, head.length, 0)
    return /"isSidechain":\s*(true|false)/.exec(head.toString("utf8", 0, n))?.[1] === "true"
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The staleness rule itself, shared by every catch-up leg. It is the subtle part of all of
// this, so it lives in exactly one place: a second copy is a second chance to get it wrong.
// `files` replaces the walk of `root` (Codex's rollouts live under two roots, in two formats).
function staleTranscriptTargets(root, { excludeId, state, cap, match = () => true, idOf = transcriptId, since = 0, files: given }) {
  if (!given && (!root || !existsSync(root))) return []
  const files = (given ?? walkFiles(root, (p) => p.endsWith(".jsonl") && match(p))).filter(
    (p) => !excludeId || !p.endsWith(`${excludeId}.jsonl`),
  )
  const candidates = files
    .map((p) => {
      const id = idOf(p)
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
      if (mtime < since) return null // older than the caller asked for (`backfill --since-days`)
      if (Date.now() - mtime < CATCHUP_QUIET_MS) return null // probably still running
      if (isSidechainTranscript(p)) return null // read only for the stale ones
      return { transcriptPath: p, sessionId: id, mtime }
    })
    .filter((x) => x !== null)
  // Newest first: current work is what the person's page shows, so it must not wait behind a
  // tail of months-old history. The old tail drains on later starts (and by `backfill`).
  // The cap is a runaway guard, not a policy — a workspace with more than this many stale
  // conversations drains over the next few starts.
  candidates.sort((a, b) => b.mtime - a.mtime)
  return cap ? candidates.slice(0, cap) : candidates
}

function findCursorCatchupTargets(currentConversationId, workspaceRoot, state) {
  const slug = cursorProjectSlug(workspaceRoot)
  if (!slug) return []
  return staleTranscriptTargets(join(HOME, ".cursor", "projects", slug, "agent-transcripts"), {
    excludeId: currentConversationId,
    state,
    cap: CURSOR_CATCHUP_MAX,
  })
}

// Claude Code files transcripts under ~/.claude/projects/<slug>/<sessionId>.jsonl, where the
// slug is the cwd with "/", "." and "_" all flattened to "-". That last one is not a guess:
// derived against all 162 project directories on a real machine, where `/` and `.` alone
// matched only 93 of them — `/Users/x/Projects/re_gent_headless` files under
// `-Users-x-Projects-re-gent-headless`. Getting it wrong silently finds nothing, which is the
// same shape as the bug this whole ticket is about, so it is pinned by a test.
//
// The flattening is lossy — "a.b", "a_b" and "a/b" all produce the same slug — so this maps
// cwd → directory and never the reverse. Every consumer here has the cwd in hand.
function claudeProjectSlug(workspaceRoot) {
  if (!workspaceRoot) return null
  // On Windows the drive colon and the backslashes flatten the same way: `C:\Users\me\proj` is
  // `C--Users-me-proj`. (Unverified on Windows.)
  if (isWindowsPath(workspaceRoot)) return workspaceRoot.replace(/[\\/]+$/, "").replace(/[\\/:._]/g, "-")
  return workspaceRoot.replace(/\/+$/, "").replace(/[/._]/g, "-")
}

// Claude Code's SessionEnd is the ONLY capture point on that leg, so a crash, a SIGKILL, the
// hook's own timeout — or the plugin sitting disabled for a week — loses the conversation with
// nothing to notice it. Codex and Cursor both self-heal on their next start; this gives Claude
// the same net. Scoped to the current workspace's project directory, because that is the one
// place where the new session's cwd is also the right cwd for the older conversations.
function findClaudeCatchupTargets(currentSessionId, workspaceRoot, state) {
  const slug = claudeProjectSlug(workspaceRoot)
  if (!slug) return []
  return staleTranscriptTargets(join(HOME, ".claude", "projects", slug), {
    excludeId: currentSessionId,
    state,
    cap: CLAUDE_CATCHUP_MAX,
  })
}

// `backfill` sweeps EVERY project directory, not just the current workspace — the whole point
// is the history a per-workspace drip can never reach. Same staleness rule, no cap here (the
// caller batches), and no current session to exclude.
function findClaudeBackfillTargets(state, since = 0) {
  return staleTranscriptTargets(join(HOME, ".claude", "projects"), { excludeId: null, state, cap: 0, since })
}

// A transcript's session id is its file name, except for Codex, whose rollout files are named
// `rollout-<timestamp>-<session id>.jsonl`: there the plugin's own bookkeeping (sync-state, the
// backfill list and its counts) uses the UUID at the end, the hooks' `session_id`, so a session
// is one entry however it was found. The id uploaded to the server stays the stem (uploadOne).
const transcriptId = (p) => p.split(/[\\/]/).pop()?.replace(/\.jsonl(?:\.zst)?$/, "") ?? p
const UUID_TAIL_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
const codexTranscriptId = (p) => transcriptId(p).match(UUID_TAIL_RE)?.[1] ?? transcriptId(p)

// Every harness's history, for `backfill` (1SI-4098). Cursor keeps other files under projects/,
// so only its agent-transcripts count.
const BACKFILL_AGENTS = ["claude", "codex", "cursor"]
function findBackfillTargets(agent, state, since = 0) {
  if (agent === "claude") return findClaudeBackfillTargets(state, since)
  if (agent === "codex") {
    // Compressed rollouts this Node cannot read are left out here, and counted by unreadableCodexRollouts.
    const files = codexRollouts().filter((p) => zstdDecompress || !isZst(p))
    return staleTranscriptTargets(null, { excludeId: null, state, cap: 0, idOf: codexTranscriptId, since, files })
  }
  return staleTranscriptTargets(join(HOME, ".cursor", "projects"), {
    excludeId: null, state, cap: 0, match: (p) => /[\\/]agent-transcripts[\\/]/.test(p), since,
  })
}

// Every harness's backfill targets in one list, newest first.
function allBackfillTargets(agents, state, since = 0) {
  const perAgent = agents.map((agent) => ({ agent, targets: findBackfillTargets(agent, state, since) }))
  const targets = perAgent
    .flatMap(({ agent, targets: ts }) => ts.map((t) => ({ ...t, agent })))
    .sort((a, b) => b.mtime - a.mtime)
  return { perAgent, targets }
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
// gateway precisely so a long-lived credential in a config file can't read the org's System Model.
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
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    // fetch's own error says only "fetch failed"; the host it was reaching goes with it.
    if (err && typeof err === "object") err.host = new URL(url).host
    throw err
  }
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

async function deviceLogin(gatewayUrl, { onPrompt = console.log, onCode = () => {} } = {}) {
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
  onCode({ verifyUrl, userCode, expiresIn: expiresIn ?? 900, complete: Boolean(start.json.verification_uri_complete) })
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
  // One refresh at a time across processes (several sessions starting together each spawn a
  // worker), under the lock the upload record already uses. Inside it, re-read the stored
  // settings: another worker may have refreshed already, and a rotating sign-in service treats a
  // refresh token presented twice as stolen.
  const fresh = await withStateLockAsync(async () => {
    // Re-read before writing: a concurrent `disable` or `--repo` edit must not be clobbered by
    // an upload that happened to refresh its token at the same moment. Only `oauth` is ours.
    const current = loadConfig() ?? cfg
    const stored = current.oauth ?? oauth
    if (stored.accessToken && stored.expiresAt && Date.now() < stored.expiresAt - TOKEN_SKEW_MS) return stored
    if (!stored.refreshToken) throw new Error("the stored access token expired and there is no refresh token — run `login` again")
    const next = { ...(await refreshAccessToken(gatewayUrl, stored.refreshToken)), issuer: stored.issuer ?? oauth.issuer,
      ...(stored.gateway && { gateway: stored.gateway }) }
    saveConfig({ ...current, oauth: next })
    return next
  }, 15_000)
  // The rest of this process's run uses it too: a catch-up of several transcripts passes the
  // same settings to every upload, and must not refresh again with the old refresh token.
  cfg.oauth = fresh
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

// The capture scope: `global`, or the local repository directories given to `login`/`install`.
// A directory is in scope when it is one of those directories or inside one (the parsers' rule).
function captureScope(cfg) {
  const scope = cfg.scope === "global" ? "global" : "repo"
  return { scope, repos: scope === "repo" ? normalizeRepos(cfg.repos ?? []) : [] }
}
function inCaptureScope(cfg, dir) {
  const { scope, repos } = captureScope(cfg)
  return scope === "global" || Boolean(repoFor(dir, repos))
}

async function uploadOne({ agent, cfg, sessionId, transcriptPath, cwd }) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    await log(`upload: session=${sessionId} agent=${agent} skipped — transcript not found (${transcriptPath ?? "unresolved"})`)
    return
  }
  // The live hooks too: a Cursor hook can hand over a sub-agent's transcript_path, and an id with no path
  // can resolve to one under subagents/.
  if ((agent === "claude" || agent === "cursor") && isSidechainTranscript(transcriptPath)) {
    await log(`upload: session=${sessionId} agent=${agent} skipped — a sub-agent transcript, part of its lead session`)
    return
  }

  const { scope, repos } = captureScope(cfg)
  const scrubber = new Scrubber()
  // Cursor's records carry no cwd of their own, so the workspace root arrives from the hook
  // payload instead and has to be threaded in — hence the separate call rather than one
  // uniform `parse(path, scrubber, repos, scope)`.
  const parsed =
    agent === "cursor"
      ? { conversation: parseCursorFile(transcriptPath, scrubber, repos, scope, cwd) }
      : agent === "codex"
        ? parseCodexRollout(transcriptPath, scrubber, repos, scope)
        : { conversation: parseClaudeFile(transcriptPath, scrubber, repos, scope) }
  const conversation = parsed.conversation
  if (!conversation) {
    await log(
      `upload: session=${sessionId} agent=${agent} skipped — ${parsed.skipped ?? "no messages, or outside the configured repo scope"}`,
    )
    return
  }

  // The local dedup key comes from the CONVERSATION, never the caller, so every path that finds
  // one file (a hook's id, the catch-up, backfill) files it under one key. For Claude and Cursor
  // that is the file name, the hook's session id. For Codex it is the UUID at the end of the
  // rollout stem (1SI-4111): the hooks' `session_id`, and the id backfill lists and counts.
  //
  // The Codex conversation still UPLOADS under the whole stem `rollout-<ts>-<uuid>`. The pipeline
  // keys the Session node on it (`user:<user id>:<sessionId>`, import_activities._session_key),
  // so a session uploaded before as the stem would come back as a second Session under the UUID.
  const dedupKey = agent === "codex" ? codexTranscriptId(conversation.sessionId) : conversation.sessionId || sessionId
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

  if (!captureGatewayAllowed(gatewayUrl)) {
    recordAttempt({ ok: false, step: "presign", host: "", detail: "not a Bonez-operated gateway", short: "the configured server is not a Bonez one" })
    await log("upload: skipped — session capture requires a Bonez-operated gateway")
    return
  }
  const mismatch = signInMismatch(cfg, gatewayUrl)
  if (mismatch) {
    recordAttempt({ ok: false, step: "sign-in", host: mismatch.target, detail: `signed in to ${mismatch.signedIn}, not ${mismatch.target}`, short: `signed in to ${mismatch.signedIn}, not ${mismatch.target}` })
    await log(`upload: session=${dedupKey} agent=${agent} not sent — signed in to ${mismatch.signedIn}, but the server address is ${mismatch.target} (from ${gatewaySource()})`)
    return
  }
  // Each step names itself and its host, so a failure says where and why (never a credential or
  // a URL's query string: the upload URL is presigned).
  let step = "token refresh"
  let host = new URL(gatewayUrl).host
  let pre
  try {
    const bearer = await resolveBearer(cfg, gatewayUrl)
    step = "presign"
    pre = await presign(gatewayUrl, bearer, wireAgent, scope)
    if (!pre.ok || !pre.json.upload_id || !pre.json.url) throw httpError(pre.status)
    step = "upload"
    host = new URL(pre.json.url).host
    const put = await putGzip(pre.json.url, gz)
    if (!put.ok) throw httpError(put.status)
    step = "complete"
    host = new URL(gatewayUrl).host
    const done = await completeUpload(gatewayUrl, bearer, pre.json.upload_id)
    if (!done.ok) throw httpError(done.status)
  } catch (err) {
    const failure = describeFailure(step, err.host ?? host, err)
    recordAttempt({ ok: false, ...failure })
    await log(`upload: session=${dedupKey} agent=${agent} ${failure.step} to ${failure.host} failed — ${failure.detail}`)
    return
  }
  recordAttempt({ ok: true })

  recordUpload(dedupKey, {
    agent,
    messageCount,
    contentHash,
    lastUploadedAt: Date.now(),
    uploadId: pre.json.upload_id,
  })
  await log(
    `upload: session=${dedupKey} agent=${agent} messages=${messageCount} redactions=${scrubReport.total} bytes=${gz.length} upload_id=${pre.json.upload_id} OK`,
  )
  return true
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
    await announceSession(agent, cfg, payload, root)
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
    await announceSession(agent, cfg, payload, typeof payload.cwd === "string" && payload.cwd ? payload.cwd : undefined)
    const target = findCodexCatchupTarget(payload.session_id ?? "")
    if (!target) {
      await log("upload: codex session-start — no other session to catch up")
      return
    }
    await uploadOne({ agent, cfg, sessionId: target.sessionId, transcriptPath: target.transcriptPath })
    return
  }

  if (agent === "claude" && event === "session-start") {
    // Claude Code's SessionStart payload carries `cwd`; workspaceRootFrom reads Cursor's
    // `workspace_roots` shape, so it is the fallback here rather than the other way round.
    const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : workspaceRootFrom(payload)
    await announceSession(agent, cfg, payload, root)
    const targets = findClaudeCatchupTargets(payload.session_id ?? "", root, loadState())
    if (!targets.length) {
      await log("upload: claude session-start — nothing stale in this workspace")
      return
    }
    await log(`upload: claude session-start — ${targets.length} stale session(s) to flush`)
    for (const t of targets) {
      // Sequential for the same reason as the Cursor leg: these share the presign/PUT/complete
      // path and sync-state on disk, and a start hook has no deadline worth racing for.
      await uploadOne({ agent, cfg, sessionId: t.sessionId, transcriptPath: t.transcriptPath })
    }
    return
  }

  // `turn-end` (Cursor's `stop`, fired after every agent turn while the window is still
  // alive) takes the same path as `session-end`: flush THIS conversation. It needs no branch
  // of its own — shouldSkip's debounce plus the content hash already collapse a chatty
  // sequence of turns into at most one upload per DEBOUNCE_MS, and an unchanged transcript
  // into none. It exists because Cursor cannot run a hook at all on window_close, so a
  // conversation that is only captured at the end is a conversation that is usually lost.
  //
  // Claude Code and Codex both key on `session_id`. Cursor sends that too, but its transcript
  // is filed under `conversation_id` — "Stable ID of the conversation across many turns" — and
  // the two are not documented to be equal, so the conversation id leads on that leg. It is
  // also the better dedup key regardless: it is what survives a resume.
  const sessionId = hostSessionId(agent, payload)
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

// -------------------------------------------------------------------------------- live session
//
// While capture is on and the session's repository is in the capture scope, the gateway is told
// that the session is running and which of the repository's files it reads and edits, so
// teammates see it live (1SI-3763). What is sent: the host's session id, the repository as
// `owner/name`, the surface, and repository-relative file paths. Never content, a prompt, a
// command, a title or a laptop path. There is no end call: the transcript upload ends it.
//
// Codex too (1SI-4111), under the id its upload is filed under: the rollout stem, not the hook's
// session_id (liveSessionId). The two must be one id, or the live session never ends.
//
// Files under <data>/presence/, per host session id:
//   <id>.json    written by the start worker: {repo, root} once announced, {refused} after a
//                403/409 on start or a 403/404/409 on events. No file or refused = the tool hook
//                sends nothing, and the recall hook does not name the session.
//   <id>.ndjson  the tool hook's spool of touches.
//   <id>.lock    a drain worker is running. The tool hook spawns one only when it takes this, so
//                a burst of tool calls costs one background process, not one per call.
// A session's files go at its end; a session start sweeps any older than three days.

// The gateway's own rule for the x-bonez-session header. Also keeps the id safe as a file name.
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const PRESENCE_TOOLS = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit" }
const PRESENCE_BATCH_MS = 1_000
const PRESENCE_LOCK_STALE_MS = 60_000
const MAX_EVENTS_PER_CALL = 200 // the gateway's MAX_EVENTS
const presencePath = (id, ext) => join(dataDir(), "presence", `${id}.${ext}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Claude Code and Codex key on `session_id`; Cursor files its transcript under `conversation_id`.
function hostSessionId(agent, payload) {
  return (agent === "cursor" && typeof payload.conversation_id === "string" ? payload.conversation_id : undefined) ??
    payload.session_id
}

// The id the gateway knows this session by, live and once uploaded: the Session node's key is
// `user:<user id>:<id>` both ways. For Claude Code and Cursor it is the host's session id. A Codex
// session uploads under its rollout stem `rollout-<ts>-<uuid>` (uploadOne), so it is announced under
// that too, read off `transcript_path`, which every Codex hook carries (SessionStart included: Codex
// writes the rollout before it runs the hook, codex-rs/core session hook_transcript_path). Without a
// rollout whose name ends in the hook's session_id there is no id, and nothing is announced.
function liveSessionId(agent, payload) {
  if (agent !== "codex") return hostSessionId(agent, payload)
  const uuid = payload?.session_id
  const stem = typeof payload?.transcript_path === "string" ? transcriptId(payload.transcript_path) : ""
  return typeof uuid === "string" && UUID_TAIL_RE.test(uuid) && stem.startsWith("rollout-") && stem.endsWith(uuid) ? stem : undefined
}

// The live id, when capture's start succeeded for it (the recall hook names it to the model).
function announcedSessionId(agent, payload) {
  const id = liveSessionId(agent, payload)
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return undefined
  const announced = readJsonSafe(presencePath(id, "json"), null)
  return announced && !announced.refused ? id : undefined
}

// Forget the session's presence at its end, and sweep what crashed sessions left behind.
function forgetPresence(id) {
  for (const ext of ["json", "ndjson", "lock"]) {
    try {
      unlinkSync(presencePath(id, ext))
    } catch {
      /* not there */
    }
  }
}
const PRESENCE_MAX_AGE_MS = 3 * 24 * 3600_000
function prunePresence() {
  try {
    const dir = join(dataDir(), "presence")
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      if (Date.now() - statSync(file).mtimeMs > PRESENCE_MAX_AGE_MS) unlinkSync(file)
    }
  } catch {
    /* no presence yet */
  }
}

function writePresence(id, value) {
  mkdirSync(join(dataDir(), "presence"), { recursive: true, mode: 0o700 })
  writeJsonAtomic(presencePath(id, "json"), value, 0o600)
}

async function sessionsCall(cfg, gatewayUrl, id, route, body) {
  try {
    const bearer = await resolveBearer(cfg, gatewayUrl)
    const res = await fetch(`${gatewayUrl}/graph/sessions/${route}`, {
      method: "POST",
      headers: httpHeaders(bearer, { "content-type": "application/json", "x-bonez-session": id }),
      body: JSON.stringify(body),
      // Under the hooks' own 5-second limit (hooks/hooks.json), so a slow answer is logged here instead of the
      // hook being cut with nothing written. No retry: the next event announces the session again.
      signal: AbortSignal.timeout(4_000),
    })
    return { ok: res.ok, status: res.status }
  } catch (err) {
    return { ok: false, status: err instanceof Error ? err.message : String(err) }
  }
}

// Runs in the session-start worker, never in the hook.
async function announceSession(agent, cfg, payload, cwd) {
  if (agent !== "claude" && agent !== "cursor" && agent !== "codex") return
  const id = liveSessionId(agent, payload)
  prunePresence()
  // Every start that is not announced says why, in one line.
  const skip = (why) => log(`presence: start session=${typeof id === "string" ? id.slice(0, 128) : "?"} agent=${agent} not announced — ${why}`)
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return skip("no usable session id")
  if (!cwd) return skip("no working directory")
  if (!inCaptureScope(cfg, cwd)) return skip("the folder is outside the capture scope")
  if (existsSync(presencePath(id, "json"))) return skip("announced before (a resume), or refused")
  const gatewayUrl = gatewayBaseUrl()
  if (!captureGatewayAllowed(gatewayUrl)) return skip("not a Bonez-operated gateway")
  const mismatch = signInMismatch(cfg, gatewayUrl)
  if (mismatch) return skip(`signed in to ${mismatch.signedIn}, but the server address is ${mismatch.target}`)
  // A folder that is no Git checkout (a folder of several repositories, say) is announced with
  // no repository; its file touches are not sent, since they have no repository to be relative to.
  let root
  let repo
  try {
    root = realpathSync.native(git(cwd, "rev-parse", "--show-toplevel"))
    repo = originRepo(cwd)
  } catch {
    /* not a Git checkout */
  }
  for (let attempt = 1; ; attempt++) {
    const res = await sessionsCall(cfg, gatewayUrl, id, "start", { surface: wireAgentFor(agent), ...(repo && { repo }) })
    if (res.status === 503 && attempt < 3) {
      await sleep(2_000)
      continue
    }
    // 403: a gateway without this route. 409: an id this credential cannot use. Neither retries.
    if (res.ok) writePresence(id, repo ? { repo, root } : { repo: null })
    else if (res.status === 403 || res.status === 409) writePresence(id, { refused: res.status })
    await log(`presence: start session=${id} agent=${agent} ${res.ok ? "OK" : `failed — HTTP ${res.status}`}`)
    return
  }
}

// The files one tool call touched, as { tool, path } with the path as the tool was given it. Codex
// edits through apply_patch, whose input is a patch naming any number of files.
function touchedFiles(agent, payload) {
  if (agent === "codex") return payload.tool_name === "apply_patch" ? applyPatchFiles(payload.tool_input) : []
  const tool = PRESENCE_TOOLS[payload.tool_name]
  const path = payload.tool_input?.file_path ?? payload.tool_input?.path
  return tool && typeof path === "string" && path ? [{ tool, path }] : []
}

// The tool hook's whole job: local reads, one append, at most one spawn. No Git, no network.
function recordTouch(agent, payload) {
  if (agent !== "claude" && agent !== "cursor" && agent !== "codex") return
  const touched = touchedFiles(agent, payload)
  const id = liveSessionId(agent, payload)
  if (!touched.length || typeof id !== "string" || !SESSION_ID_RE.test(id)) return
  const announced = readJsonSafe(presencePath(id, "json"), null)
  if (typeof announced?.repo !== "string" || typeof announced.root !== "string") return
  const base = (typeof payload.cwd === "string" && payload.cwd) || workspaceRootFrom(payload)
  const at = new Date().toISOString()
  let lines = ""
  for (const { tool, path: given } of touched) {
    if (!isAbsolute(given) && !base) continue
    let file = resolve(base || "", given)
    try {
      file = realpathSync.native(file)
    } catch {
      // A file deleted since keeps its name, in its folder's real path (the root is a real path too).
      try {
        file = join(realpathSync.native(dirname(file)), basename(file))
      } catch {
        /* its folder is gone too: the path as given */
      }
    }
    const rel = relative(announced.root, file)
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || /[\x00-\x1f\x7f]/.test(rel)) continue
    lines += `${JSON.stringify({ tool, args: { path: `${announced.repo}/${rel.split(sep).join("/")}` }, at })}\n`
  }
  if (!lines) return
  appendFileSync(presencePath(id, "ndjson"), lines, { mode: 0o600 })
  if (takePresenceLock(id)) spawnWorker(["_presence", id])
}

function takePresenceLock(id) {
  const lock = presencePath(id, "lock")
  for (let i = 0; i < 2; i++) {
    try {
      closeSync(openSync(lock, "wx"))
      return true
    } catch {
      // A crashed drain worker must not stop the session's touches for good.
      try {
        if (Date.now() - statSync(lock).mtimeMs < PRESENCE_LOCK_STALE_MS) return false
        unlinkSync(lock)
      } catch {
        /* gone already: try again */
      }
    }
  }
  return false
}

// The drain worker: waits a moment so a burst lands in one call, sends the spool, repeats while
// touches keep coming, then releases the lock. A touch appended between the last drain and the
// release is picked up by re-taking the lock rather than waiting for the next tool call.
async function cmdPresence(id) {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) return
  const lock = presencePath(id, "lock")
  do {
    while (await drainPresence(id)) {
      try {
        utimesSync(lock, new Date(), new Date())
      } catch {
        /* lock gone: the loop ends with the next empty drain */
      }
    }
    try {
      unlinkSync(lock)
    } catch {
      /* already gone */
    }
  } while (existsSync(presencePath(id, "ndjson")) && takePresenceLock(id))
}

async function drainPresence(id) {
  await sleep(PRESENCE_BATCH_MS)
  const spool = presencePath(id, "ndjson")
  const sending = `${spool}.sending-${process.pid}`
  try {
    renameSync(spool, sending)
  } catch {
    return false // nothing spooled
  }
  let events
  try {
    events = readFileSync(sending, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    events = []
  }
  try {
    unlinkSync(sending)
  } catch {
    /* ignore */
  }
  const cfg = loadConfig()
  const announced = readJsonSafe(presencePath(id, "json"), null)
  if (disabledByEnv() || !cfg?.enabled || !hasCredential(cfg) || !announced?.repo) return true
  const gatewayUrl = gatewayBaseUrl()
  if (!captureGatewayAllowed(gatewayUrl) || signInMismatch(cfg, gatewayUrl)) return true
  for (let i = 0; i < events.length; i += MAX_EVENTS_PER_CALL) {
    const res = await sessionsCall(cfg, gatewayUrl, id, "events", { events: events.slice(i, i + MAX_EVENTS_PER_CALL) })
    if (res.ok) continue
    // 403: a gateway without the route. 404/409: a session this credential cannot write to.
    if ([403, 404, 409].includes(res.status)) writePresence(id, { refused: res.status })
    await log(`presence: events session=${id} failed — HTTP ${res.status}`)
    break
  }
  return true
}

// -------------------------------------------------------------------------------- capture health
//
// Uploads run in a background process nobody watches, so a broken setup used to be silent for
// months. health.json in the data folder keeps the last three upload attempts and the day each
// notice was last shown. Local only; nothing here makes a network call.

const healthPath = () => join(dataDir(), "health.json")
const DAY_MS = 86_400_000

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

// The cause, in the log's words (`detail`) and in the person's (`short`).
function describeFailure(step, host, err) {
  const cause = err?.cause && typeof err.cause === "object" ? err.cause : err
  const code = cause?.code ?? (err?.status ? `HTTP ${err.status}` : undefined)
  const message = String(cause?.message ?? err?.message ?? err).split("?")[0].slice(0, 200)
  let short = `${step} failed`
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code ?? "")) short = "certificate check failed"
  else if (/ENOTFOUND|EAI_AGAIN/.test(code ?? "")) short = "server not found"
  else if (/ECONN|ETIMEDOUT|UND_ERR/.test(code ?? "")) short = "could not reach the server"
  else if (err?.status === 401 || err?.status === 403 || /^refresh failed/.test(message)) short = "sign-in refused"
  return { step, host, detail: code && code !== message ? `${code}: ${message}` : message, short }
}

function recordAttempt(attempt) {
  try {
    withStateLock(() => {
      const health = readJsonSafe(healthPath(), {})
      health.attempts = [...(health.attempts ?? []), { at: Date.now(), ...attempt }].slice(-3)
      writeJsonAtomic(healthPath(), health, 0o600)
    })
  } catch {
    /* health is advisory */
  }
}

function lastSuccessAt() {
  const times = Object.values(loadState()).map((e) => e?.lastUploadedAt ?? 0)
  return times.length ? Math.max(...times) || undefined : undefined
}

// Older folders holding settings that this process's folder does not have and will not read.
function strandedSettings() {
  return [CANONICAL_DATA_DIR, ...legacyDataDirs()].filter(
    (d) => d !== dataDir() && existsSync(join(d, "config.json")),
  )
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const shortDate = (ms) => `${new Date(ms).getDate()} ${MONTHS[new Date(ms).getMonth()]}`

// Capture is on: is it working? Decided only from what the uploader recorded. An attempt is a
// session it meant to send (it had messages, in scope, changed); one it skips on purpose (empty,
// unchanged, out of scope) or has not reached yet (a session still open) is not an attempt, so it
// never counts. Either the last three attempts all failed, or the last one failed and nothing has
// uploaded for three days.
function captureNotice(cfg) {
  const mismatch = signInMismatch(cfg, gatewayBaseUrl())
  if (mismatch) return { reason: "mismatch", text: mismatchText(mismatch) }
  const attempts = readJsonSafe(healthPath(), {}).attempts ?? []
  const last = attempts.at(-1)
  if (!last || last.ok) return null
  const lastOk = lastSuccessAt()
  const since = lastOk ? `since ${shortDate(lastOk)}` : "yet"
  if (attempts.length >= 3 && attempts.every((a) => !a.ok)) {
    return { reason: "failing", text: `Bonez session capture has not uploaded ${since} (${last.short}).` }
  }
  const baseline = lastOk ?? Date.parse(cfg.installedAt ?? "")
  if (!(Date.now() - baseline > 3 * DAY_MS)) return null
  return { reason: "stale", text: `Bonez session capture has not uploaded ${since}, though sessions ran after that (${last.short}).` }
}

// The one line the PERSON sees: Claude Code shows a hook's `systemMessage` to the user and does
// not add it to the model's context. At most once a day per reason. Cursor's and Codex's
// session-start hooks have no such field, so they never print one.
function notifyOnce(reason, text) {
  try {
    // The same lock as recordAttempt, so a background upload's record is never overwritten. A
    // short wait: the uploader holds it for one small write, and the hook must stay fast.
    const shown = withStateLock(() => {
      const health = readJsonSafe(healthPath(), {})
      const today = new Date().toISOString().slice(0, 10)
      if (health.notified?.[reason] === today) return false
      health.notified = { ...health.notified, [reason]: today }
      writeJsonAtomic(healthPath(), health, 0o600)
      return true
    }, 500)
    if (!shown) return
    process.stdout.write(JSON.stringify({ systemMessage: `${text} Run \`node "${SELF_PATH}" status\` for details.` }))
  } catch {
    /* never fail the hook */
  }
}

// -------------------------------------------------------------------------------- opt-in offer (1SI-4098)

// Capture used to stay off until someone ran `login` by hand, and nothing told anyone to, so no
// customer ever turned it on. Now a session start on a machine that never set capture up offers it
// with a ready approval link: one click in the browser and capture is on, for every repo. The
// offer is the device flow `login` runs, started by a detached worker so the hook stays fast.
//
// The state lives in the shared store (one per machine, whichever client asked), not the
// config: there is no config until the person says yes, and a "no" must not look like an install.
const optinPath = () => join(CANONICAL_DATA_DIR, "optin.json")
const OFFER_FIRST_SHOWS = 3 // the first few offers, at most one a day…
const OFFER_DAILY_MS = 20 * 60 * 60 * 1000
const OFFER_WEEKLY_MS = 7 * DAY_MS // …then at most one a week, until a yes or a no
const OFFER_WAIT_MS = 3500 // how long the hook waits for the worker's link (3 round trips: ~2.4s on prod Auth0)
const OFFER_LINK_MIN_MS = 3 * 60_000 // a pending link with less time left than this is not shown

function readOptin() {
  return readJsonSafe(optinPath(), {})
}

function writeOptin(next) {
  try {
    mkdirSync(CANONICAL_DATA_DIR, { recursive: true, mode: 0o700 })
    writeJsonAtomic(optinPath(), next, 0o600)
  } catch {
    /* the offer is advisory */
  }
}

// Whether this start may show the offer: never after a no, never with BONEZ_CAPTURE_OFFER=0 (for CI
// and shared machines), never for a gateway capture does not serve, and on a slowing schedule otherwise.
function offerDue(state, now = Date.now()) {
  if (process.env.BONEZ_CAPTURE_OFFER === "0" || !OAUTH_CLIENT_ID) return false
  if (state.declinedAt || state.enabledAt) return false
  if (!captureGatewayAllowed(gatewayBaseUrl())) return false
  const shown = state.shown ?? 0
  if (!state.lastShownAt) return true
  const gap = now - state.lastShownAt
  return shown < OFFER_FIRST_SHOWS ? gap > OFFER_DAILY_MS : gap > OFFER_WEEKLY_MS
}

// How the person runs a capture subcommand from where they are: the plugin's slash command where
// the client has one, the script itself otherwise.
function captureCmd(agent, sub) {
  if (agent === "claude") return `/bonez:capture ${sub}`
  if (agent === "cursor") return `/bonez-capture ${sub}`
  return `node "${SELF_PATH}" ${sub === "off" ? "decline" : sub}`
}

function offerText(agent, verifyUrl) {
  return (
    `Bonez can save your coding sessions to your team's Bonez, so it learns from them (secrets are removed on this machine first). ` +
    `Turn it on with one click: ${verifyUrl} — Not now: ignore this. Never: ${captureCmd(agent, "off")}`
  )
}

function enabledText(agent, state = {}) {
  if (state.enabledVia === "connect") {
    return (
      "Bonez is saving your sessions on this computer now: you turned it on in the browser." +
      (state.backfillStartedAt ? " Your sessions from the last 14 days are being added in the background." : "")
    )
  }
  return (
    "Bonez session capture is on: sessions on this machine are now saved to your team's Bonez when they end. " +
    `To add your recent sessions too: ${captureCmd(agent, "backfill")}`
  )
}

// What each client can show the person at session start. Claude Code shows a hook's
// `systemMessage` to the person and keeps it out of the model's context; Codex shows it as a
// warning in its UI (developers.openai.com/codex/hooks). Cursor's sessionStart has no field the
// person sees (`user_message` is not enforced there), so its offer reaches the person through the
// agent, as context it is asked to relay once (cursor.com/docs/agent/hooks).
//
// In Codex every line also says how to keep the hooks on. Codex approves a plugin's hooks against a
// hash of the hook definition AND of every file in the plugin folder (codex-rs/hooks/src/engine/
// plugin_fingerprint.rs, plugin_trust.rs), so any update, even one that changes only the version,
// turns all of Bonez's hooks off until the person approves them again. Keeping hooks.json the same
// across releases cannot avoid that, so the person is told instead.
const CODEX_REVIEW_HOOKS = "After each Bonez update, Codex turns its hooks off until you approve them again: run /hooks (or Review hooks in the app) and approve Bonez."
function emitNotice(agent, text) {
  if (agent === "codex") text = `${text} ${CODEX_REVIEW_HOOKS}`
  if (agent === "cursor") {
    const relay = `Tell the user this once, at the start of your first reply, word for word, then carry on with their request: "${text}"`
    process.stdout.write(JSON.stringify({ additional_context: relay }))
    return
  }
  process.stdout.write(JSON.stringify({ systemMessage: text }))
}

// The first session start after the person approved the offer says so, once.
function announceEnabled(agent) {
  const state = readOptin()
  if (!state.enabledAt || state.announcedAt) return false
  writeOptin({ ...state, announcedAt: Date.now() })
  emitNotice(agent, enabledText(agent, state))
  return true
}

// Hook path: no config on this machine. Show the "capture is on" line once after a yes, or the
// offer when it is due. Waits at most OFFER_WAIT_MS for the worker's link; with no link in time it
// says nothing and counts nothing, so the next start tries again.
async function offerCapture(agent) {
  if (announceEnabled(agent)) return
  const state = readOptin()
  if (!offerDue(state)) return
  let pending = state.pending
  if (!(pending?.verifyUrl && pending.expiresAt - Date.now() > OFFER_LINK_MIN_MS)) {
    const nonce = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)
    writeOptin({ ...state, pending: { nonce, startedAt: Date.now() } })
    if (!spawnWorker(["_optin", nonce])) return
    const deadline = Date.now() + OFFER_WAIT_MS
    pending = undefined
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100))
      const p = readOptin().pending
      if (p?.nonce !== nonce) return // another start took over the offer
      if (p.verifyUrl) {
        pending = p
        break
      }
      if (p.error) return
    }
    if (!pending) return
  }
  const now = Date.now()
  writeOptin({ ...readOptin(), lastShownAt: now, shown: (state.shown ?? 0) + 1 })
  emitNotice(agent, offerText(agent, pending.verifyUrl))
}

// Detached worker: runs the device flow the offer links to, and turns capture on, for every repo,
// when the person approves. Leaves the state as it found it on any failure, so the offer comes back.
async function cmdOptinWorker(nonce) {
  const ours = () => readOptin().pending?.nonce === nonce
  try {
    const tokens = await deviceLogin(gatewayBaseUrl(), {
      onPrompt: () => {},
      onCode: ({ verifyUrl, expiresIn }) => {
        if (!ours()) throw new Error("superseded")
        writeOptin({ ...readOptin(), pending: { nonce, verifyUrl, expiresAt: Date.now() + expiresIn * 1000 } })
      },
    })
    if (!ours()) return
    if (!tokens.refreshToken) throw new Error("no refresh token was issued")
    if (loadConfig()) return // set up by hand meanwhile; that choice stands
    saveConfig({
      enabled: true,
      scope: "global",
      repos: [],
      oauth: { ...tokens, gateway: gatewayBaseUrl() },
      installedAt: new Date().toISOString(),
      via: "offer",
    })
    const { pending: _done, ...rest } = readOptin()
    writeOptin({ ...rest, enabledAt: Date.now() })
    await log("opt-in: approved in the browser — capture is on (global)")
  } catch (err) {
    if (ours()) {
      const { pending: _gone, ...rest } = readOptin()
      writeOptin(rest)
    }
    await log(`opt-in: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Start the offer's flow by hand (the slash command's "on"): print the approval link and return at
// once, while a detached worker waits for the approval. Unlike `login` it never blocks, so an
// agent's shell tool can run it. A previous "no" is withdrawn by asking for this.
async function cmdOn() {
  if (refuseForeignGateway("on")) return
  const cfg = loadConfig()
  if (cfg?.enabled && hasCredential(cfg)) {
    console.log("bonez session capture: already on. `status` shows the last upload.")
    return
  }
  const { declinedAt: _no, ...state } = readOptin()
  const nonce = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)
  writeOptin({ ...state, pending: { nonce, startedAt: Date.now() } })
  if (!spawnWorker(["_optin", nonce])) {
    console.error("bonez session capture: could not start the sign-in. Run `login --global` instead.")
    process.exitCode = 1
    return
  }
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    const p = readOptin().pending
    if (p?.nonce !== nonce) break
    if (p.verifyUrl) {
      console.log(
        [
          "Open this link and approve, to turn Bonez session capture on for every repo on this machine:",
          `  ${p.verifyUrl}`,
          `The link works for ${Math.max(1, Math.round((p.expiresAt - Date.now()) / 60_000))} minutes. Nothing else to do: capture turns on when you approve.`,
          "Check with `status` afterwards.",
        ].join("\n"),
      )
      return
    }
  }
  console.error(`bonez session capture: the sign-in did not start. See ${logFilePath()}, or run \`login --global\`.`)
  process.exitCode = 1
}

function cmdDecline() {
  const state = readOptin()
  const { pending: _gone, ...rest } = state
  writeOptin({ ...rest, declinedAt: Date.now() })
  const cfg = loadConfig()
  if (cfg?.enabled) {
    cfg.enabled = false
    saveConfig(cfg)
  }
  console.log("bonez session capture: off, and Bonez will not ask again. Turn it on any time with `login --global`.")
}

// -------------------------------------------------------------------------------- connect (1SI-4098)

// The setup page in the browser and this machine share a pairing (specs/plugin-connect/CONTRACT.md in
// the workspace): `connect` creates it, the person signs in and answers on the page, and `connect`
// picks the answer up here: a sessions key to save, and whether to add the recent sessions too.
const CONNECT_RECENT_DAYS = 14
// At most this many of those sessions, the newest across every tool: what the page says and what is added.
// BONEZ_CONNECT_BACKFILL_MAX overrides it, only so a test need not write 200 transcripts.
const _parsedConnectMax = Number.parseInt(process.env.BONEZ_CONNECT_BACKFILL_MAX ?? "", 10)
const CONNECT_BACKFILL_MAX = Number.isFinite(_parsedConnectMax) && _parsedConnectMax > 0 ? _parsedConnectMax : 200
const connectTargets = () =>
  allBackfillTargets(BACKFILL_AGENTS, loadState(), Date.now() - CONNECT_RECENT_DAYS * DAY_MS).targets.slice(0, CONNECT_BACKFILL_MAX)
const CONNECT_TOOL_IDS = ["claude-code", "codex", "cursor", "opencode", "claude-app"]
const CONNECT_OPENERS = new Set(["claude-code", "codex", "cursor", "opencode", "installer"])
const CONNECT_OPENER_FOR = { claude: "claude-code", codex: "codex", cursor: "cursor" }
const CONNECT_MAX_POLL_ERRORS = 10
const CONNECT_HTTP_TIMEOUT_MS = 15_000
// Only so the tests need not wait the server's two seconds a poll.
const _parsedConnectPoll = Number.parseInt(process.env.BONEZ_CONNECT_POLL_MS ?? "", 10)
const CONNECT_POLL_MS = Number.isFinite(_parsedConnectPoll) && _parsedConnectPoll > 0 ? _parsedConnectPoll : undefined

const newNonce = () => createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16)

function onPath(name) {
  const win = process.platform === "win32"
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue
    for (const ext of win ? ["", ".exe", ".cmd", ".bat"] : [""]) if (existsSync(join(dir, name + ext))) return true
  }
  return false
}

// The tools on this machine the setup page lists. BONEZ_CONNECT_TOOLS=claude-code,codex replaces the
// detection (tests; an empty value means none).
function detectTools() {
  const override = process.env.BONEZ_CONNECT_TOOLS
  let ids
  if (override !== undefined) {
    ids = override.split(",").map((s) => s.trim()).filter((s) => CONNECT_TOOL_IDS.includes(s))
  } else {
    const home = homedir()
    const localAppData = process.env.LOCALAPPDATA
    const found = {
      "claude-code": existsSync(join(home, ".claude")) || onPath("claude"),
      codex: Boolean(process.env.CODEX_HOME && existsSync(process.env.CODEX_HOME)) || existsSync(join(home, ".codex")),
      cursor: existsSync(join(home, ".cursor")),
      opencode: existsSync(join(home, ".config", "opencode")) || onPath("opencode"),
      "claude-app":
        process.platform === "darwin"
          ? existsSync("/Applications/Claude.app") || existsSync(join(home, "Applications", "Claude.app"))
          : process.platform === "win32" && Boolean(localAppData && existsSync(join(localAppData, "AnthropicClaude"))),
    }
    ids = CONNECT_TOOL_IDS.filter((id) => found[id])
  }
  return [...new Set(ids)].map((id) => ({ id, installed: true }))
}

// The version of the plugin this script ships in (any of its three manifests).
function pluginVersion() {
  for (const dir of [".claude-plugin", ".codex-plugin", ".cursor-plugin"]) {
    const v = readJsonSafe(join(SELF_PATH, "..", "..", dir, "plugin.json"), null)?.version
    if (typeof v === "string") return v
  }
  return undefined
}

// The page link comes from the server and goes to a shell command, so only a plain http(s) link is opened.
function safeBrowserUrl(u) {
  try {
    const p = new URL(u)
    return (p.protocol === "https:" || p.protocol === "http:") && /^[A-Za-z0-9:/?#=&.,_~%+-]+$/.test(u)
  } catch {
    return false
  }
}

function openInBrowser(url) {
  let cmd = "xdg-open"
  let args = [url]
  if (process.platform === "darwin") cmd = "open"
  else if (process.platform === "win32") {
    // `start`'s first quoted argument is a window title; `&` would end the command in cmd.
    cmd = "cmd"
    args = ["/c", "start", '""', url.replace(/&/g, "^&")]
  } else if (!onPath("xdg-open")) return false
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: process.platform === "win32" })
    child.on("error", () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

// `CODE.SECRET`: the pairing Settings -> Bonez Plugin made and put in its install command (BONEZ_PAIR).
function parsePair(raw) {
  const m = /^([A-Za-z0-9]{4}-?[A-Za-z0-9]{4})\.([A-Za-z0-9_-]{16,128})$/.exec(String(raw ?? "").trim())
  if (!m) return undefined
  const bare = m[1].replace("-", "").toUpperCase()
  return { code: `${bare.slice(0, 4)}-${bare.slice(4)}`, secret: m[2] }
}

function parseConnectArgs(rest) {
  const o = { opener: "installer", open: process.env.BONEZ_CONNECT_NO_OPEN !== "1", detach: false, quiet: false, nonce: undefined, pair: process.env.BONEZ_PAIR || undefined }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === "--opener") o.opener = rest[++i]
    else if (a.startsWith("--opener=")) o.opener = a.slice("--opener=".length)
    else if (a === "--pair") o.pair = rest[++i]
    else if (a.startsWith("--pair=")) o.pair = a.slice("--pair=".length)
    else if (a === "--no-open") o.open = false
    else if (a === "--detach") o.detach = true
    else if (a === "--quiet") o.quiet = true // the detached child: sync.log only
    else if (a === "--nonce") o.nonce = rest[++i]
    // The demo: the whole installer with fake timing, no network, no file touched.
    else if (a === "--demo") o.demo = true
    else if (a === "--joining") o.demoJoining = true
    else if (a.startsWith("--until=")) o.until = a.slice("--until=".length)
    else if (a.startsWith("--speed=")) o.speed = Math.max(0.1, Number(a.slice("--speed=".length)) || 1)
  }
  if (!CONNECT_OPENERS.has(o.opener)) o.opener = "installer"
  // A hook's background `connect` makes its own pairing: a BONEZ_PAIR left in the environment is not for it.
  if ((o.detach || o.quiet) && !rest.some((a) => a === "--pair" || a.startsWith("--pair="))) o.pair = undefined
  return o
}

function startConnectWorker({ opener, open = true, nonce }) {
  return spawnWorker(["connect", "--quiet", "--opener", opener, ...(open ? [] : ["--no-open"]), ...(nonce ? ["--nonce", nonce] : [])])
}

// What the detached child tells the hook that started it (by nonce): the page link, or that it failed.
function markConnect(nonce, fields) {
  if (!nonce) return
  const state = readOptin()
  if (state.connect?.nonce === nonce) writeOptin({ ...state, connect: { ...state.connect, ...fields } })
}

// ---- the pending pairing: setup survives a closed terminal (1SI-4098)
//
// The installer used to wait in the foreground: close the terminal, answer in the browser, and the key the
// page minted was never collected. Now the pairing is written down as soon as there is one
// (pending-connect.json, 0600), a detached poller waits for the answer whether or not the terminal stays
// open, and every session start that finds a pairing nobody is polling asks once and finishes the setup.
// The foreground only shows what the poller reports (connect-progress.json).
const pendingPath = () => join(CANONICAL_DATA_DIR, "pending-connect.json")
const progressPath = () => join(CANONICAL_DATA_DIR, "connect-progress.json")
// The gateway keeps an answered key it could not hand over for 7 days; past that, a pairing is gone.
const PENDING_KEEP_MS = 8 * DAY_MS
const HOOK_COLLECT_TIMEOUT_MS = 1500
const POLLER_STALE_MS = 60_000
const WORKER_START_GRACE_MS = 10_000
const CONNECT_TOOL_LABELS = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor", opencode: "OpenCode", "claude-app": "Claude app" }

function writeCanonical(path, value) {
  mkdirSync(CANONICAL_DATA_DIR, { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

function readPending() {
  const p = readJsonSafe(pendingPath(), null)
  return p && typeof p.code === "string" && typeof p.secret === "string" && typeof p.gateway === "string" ? p : undefined
}

function writePending(p) {
  writeCanonical(pendingPath(), p)
}

function clearPending(code) {
  const p = readPending()
  if (!p || (code !== undefined && p.code !== code)) return
  try {
    unlinkSync(pendingPath())
  } catch {
    /* gone already */
  }
}

function readProgress(code) {
  const p = readJsonSafe(progressPath(), null)
  return p && p.code === code ? p : undefined
}

function reportProgress(code, patch) {
  try {
    writeCanonical(progressPath(), { ...(readProgress(code) ?? {}), ...patch, code, at: Date.now() })
  } catch {
    /* the view only; the work goes on */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

// Someone is polling this pairing right now (the installer's background helper, or a hook's).
function pollerAlive(code) {
  const p = readProgress(code)
  return Boolean(p && !p.finished && p.pid !== process.pid && pidAlive(p.pid) && Date.now() - (p.heartbeatAt ?? 0) < POLLER_STALE_MS)
}

function pairingResult(gateway, code, secret, timeoutMs) {
  return fetchJson(`${gateway}/connect/pairing-result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, secret }),
    signal: AbortSignal.timeout(timeoutMs),
  })
}

const validKey = (key) => typeof key === "string" && key.startsWith("bnz_")

// Save the sessions key the way `connect` always has: every repo, from the setup page, for the gateway it
// was paired with. `announce`: the next session start says it once (a hook collected it, nobody saw it).
function saveConnectedKey(key, gateway, { announce = false, backfill = false } = {}) {
  const cfg = { enabled: true, scope: "global", repos: [], apiKey: key, gateway, installedAt: new Date().toISOString(), via: "connect" }
  saveConfig(cfg)
  // An offer still in flight sees its pending link gone and stops.
  const { declinedAt: _no, pending: _offer, announcedAt: _said, backfillStartedAt: _bf, ...state } = readOptin()
  const now = Date.now()
  writeOptin({ ...state, enabledAt: now, enabledVia: "connect", ...(backfill && { backfillStartedAt: now }), ...(!announce && { announcedAt: now }) })
  return cfg
}

// The last 14 days of every harness, one session at a time.
async function connectBackfill(cfg, onProgress = () => {}) {
  const targets = connectTargets()
  const total = targets.length
  let added = 0
  let done = 0
  onProgress(0, total)
  for (const t of targets) {
    try {
      if (await uploadOne({ agent: t.agent, cfg, sessionId: t.sessionId, transcriptPath: t.transcriptPath })) added++
    } catch (err) {
      await log(`connect: backfill ${t.sessionId} failed — ${err instanceof Error ? err.message : String(err)}`)
    }
    onProgress(++done, total)
  }
  return { total, added }
}

// Polls one pairing until it is answered, expires or is gone, then saves the key and adds the recent
// sessions. Runs detached (the installer's helper, a hook's), or in the foreground when no helper could
// start. Says what happens in sync.log and reports it to the view through connect-progress.json.
async function waitForAnswer(p, { nonce } = {}) {
  const say = (line) => log(`connect: ${line}`)
  const report = (patch) => reportProgress(p.code, patch)
  const finish = async (fields, line) => {
    report({ ...fields, finished: true })
    if (fields.error) markConnect(nonce, { error: fields.error })
    if (line) await say(line)
  }
  const intervalMs = CONNECT_POLL_MS ?? Math.max(1, Number(p.pollInterval) || 2) * 1000
  report({ pid: process.pid, heartbeatAt: Date.now(), finished: false })
  let errors = 0
  let answer
  for (;;) {
    if (Date.now() > p.expiresAt + intervalMs) {
      clearPending(p.code)
      const error = "The setup link expired. Run this again to get a new one."
      return finish({ error }, error)
    }
    await sleep(intervalMs)
    let res
    try {
      res = await pairingResult(p.gateway, p.code, p.secret, CONNECT_HTTP_TIMEOUT_MS)
    } catch {
      res = undefined
    }
    report({ heartbeatAt: Date.now() })
    if (res?.status === 404) {
      clearPending(p.code)
      const error = "The setup link is no longer valid. Run this again to get a new one."
      return finish({ error }, error)
    }
    if (!res?.ok) {
      // The pairing stays written down: the next session start picks the answer up.
      if (++errors >= CONNECT_MAX_POLL_ERRORS) {
        const error = "Lost contact with Bonez while waiting. Setup finishes the next time you use a coding tool."
        return finish({ error }, error)
      }
      continue
    }
    errors = 0
    const { status, tools } = res.json
    if (Array.isArray(tools)) {
      const signedIn = tools.filter((t) => t && t.signed_in && CONNECT_TOOL_IDS.includes(t.id)).map((t) => t.id)
      report({ tools: signedIn })
    }
    if (status === "expired") {
      clearPending(p.code)
      const error = "The setup link expired. Run this again to get a new one."
      return finish({ error }, error)
    }
    if (status === "answered") {
      answer = res.json.sessions ?? {}
      break
    }
    if (status === "claimed" && !readProgress(p.code)?.claimed) {
      report({ claimed: true })
      if (!p.joining) await say("You're signed in. Finish the steps in your browser…")
    }
  }

  if (!answer.on) {
    clearPending(p.code)
    markConnect(nonce, { result: "off" })
    return finish({ answer: { on: false } }, "Session saving stays off. You can turn it on later with /bonez:capture on.")
  }
  if (!validKey(answer.key)) {
    clearPending(p.code)
    const error = "Session saving was turned on, but this computer did not get its key. Run this again."
    return finish({ error }, error)
  }
  // The page already said it is on, so the next session start does not say it again.
  const cfg = saveConnectedKey(answer.key, p.gateway)
  clearPending(p.code)
  markConnect(nonce, { result: "on" })
  report({ answer: { on: true, backfill: Boolean(answer.backfill) }, saved: true })
  await say("Session saving is on.")

  if (answer.backfill) {
    if (disabledByEnv()) {
      report({ backfill: { skipped: "env" } })
      await say("BONEZ_SESSION_SYNC=0 is set, so recent sessions were not added.")
    } else {
      const { total, added } = await connectBackfill(cfg, (done, n) => report({ backfill: { done, total: n }, heartbeatAt: Date.now() }))
      report({ backfill: { done: total, total, added } })
      if (!total) await say("No recent sessions to add.")
      else await say(`Adding ${total} recent session${total === 1 ? "" : "s"}… ${added}/${total}`)
      if (added < total) await say(`${total - added} were skipped or failed (see ${logFilePath()}). Try them again with: backfill --since-days=${CONNECT_RECENT_DAYS}`)
    }
  }
  return finish({ ok: true }, "All set. You can close the setup page.")
}

// Session start: a pairing that nobody is polling (the terminal and its helper are gone, or the computer
// restarted) gets one quick question. Answered with a key: setup finishes here. Gone or expired: forgotten.
// Still waiting: a helper starts polling again. One request, a short timeout, and silence on any failure.
async function collectPendingAtStart() {
  const p = readPending()
  if (!p) return
  if (!captureGatewayAllowed(p.gateway) || !(Number(p.expiresAt) > 0) || Date.now() > p.expiresAt + PENDING_KEEP_MS) {
    clearPending(p.code)
    return
  }
  if (pollerAlive(p.code)) return
  let res
  try {
    res = await pairingResult(p.gateway, p.code, p.secret, HOOK_COLLECT_TIMEOUT_MS)
  } catch {
    return
  }
  if (res.status === 404 || res.status === 410) {
    clearPending(p.code)
    await log("connect: the pending setup is gone from the server; forgotten")
    return
  }
  if (!res.ok) return
  const { status, sessions } = res.json
  if (status === "expired") {
    clearPending(p.code)
    await log("connect: the pending setup expired before it was answered; forgotten")
    return
  }
  if (status !== "answered") {
    if (Date.now() < p.expiresAt) spawnWorker(["_connect-wait", p.code])
    return
  }
  if (!sessions?.on) {
    clearPending(p.code)
    reportProgress(p.code, { answer: { on: false }, finished: true })
    await log("connect: answered in the browser while no terminal waited: session saving stays off")
    return
  }
  if (!validKey(sessions.key)) {
    // Collected by someone else already, or the server hands a key out once and it went missing.
    clearPending(p.code)
    await log("connect: answered in the browser, but there was no key left to collect")
    return
  }
  saveConnectedKey(sessions.key, p.gateway, { announce: true, backfill: Boolean(sessions.backfill) && !disabledByEnv() })
  clearPending(p.code)
  reportProgress(p.code, { answer: { on: true, backfill: Boolean(sessions.backfill) }, saved: true, finished: true, ok: true })
  await log("connect: collected the key a closed terminal left behind — session saving is on (global)")
  if (sessions.backfill && !disabledByEnv()) spawnWorker(["_connect-backfill"])
}

async function cmdConnectWaitWorker(code) {
  const p = readPending()
  if (!p || p.code !== code || pollerAlive(code)) return
  await waitForAnswer(p)
}

async function cmdConnectBackfillWorker() {
  const cfg = loadConfig()
  if (!cfg?.enabled || !cfg.apiKey || disabledByEnv()) return
  const { total, added } = await connectBackfill(cfg)
  await log(`connect: added ${added}/${total} recent sessions in the background`)
}

// `given`: the screen install-ui already drew the tool rows on; it carries on here.
async function cmdConnect(rest, given) {
  const o = parseConnectArgs(rest)
  if (o.demo) {
    const { playDemo } = await import("./lib/connect-tui.mjs")
    await playDemo({ until: o.until, speed: o.speed, joining: o.demoJoining })
    return
  }
  if (o.detach) {
    if (!startConnectWorker(o)) {
      console.error("Could not start the Bonez setup in the background.")
      process.exitCode = 1
    }
    return
  }
  const base = gatewayBaseUrl()
  if (!captureGatewayAllowed(base) && given) {
    given.fail("This Bonez server does not offer session saving.")
    process.exitCode = 1
    return
  }
  if (!captureGatewayAllowed(base)) {
    markConnect(o.nonce, { error: "not a Bonez-operated gateway" })
    if (o.quiet) {
      await log("connect: not a Bonez-operated gateway")
      process.exitCode = 1
    } else refuseForeignGateway("connect")
    return
  }
  let view = given
  if (!o.quiet && !view) {
    view = await connectView()
    // Plain output starts at the panel, as it always has; the full screen always has its header.
    if (view.caps.live) view.header()
  }
  const say = o.quiet ? (line) => log(`connect: ${line}`) : async () => {}
  const fail = async (line) => {
    markConnect(o.nonce, { error: line })
    if (o.quiet) await log(`connect: ${line}`)
    else view.fail(line)
    process.exitCode = 1
  }

  const recent = connectTargets().length
  const report = {
    opener: o.opener,
    tools: detectTools(),
    recent_sessions: recent,
    host: hostname().slice(0, 64),
    ...(pluginVersion() && { plugin_version: pluginVersion() }),
  }
  // From Settings -> Bonez Plugin's command: the page made the pairing and is open, so join it and open nothing.
  const joining = o.pair !== undefined
  const pair = joining ? parsePair(o.pair) : undefined
  if (joining && !pair) return fail("The setup command is incomplete. Copy it again from the Bonez page.")
  let pairing
  try {
    const res = await fetchJson(`${base}${joining ? "/connect/pairings/join" : "/connect/pairings"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(joining ? { pair: `${pair.code}.${pair.secret}`, ...report } : report),
      signal: AbortSignal.timeout(CONNECT_HTTP_TIMEOUT_MS),
    })
    if (joining && res.status === 410) return fail("The setup command expired. Copy a new one from the Bonez page.")
    if (joining && res.status === 404) return fail("The setup command is no longer valid. Copy a new one from the Bonez page.")
    if (res.status === 404) throw new Error("this Bonez server does not offer the setup page yet")
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (joining) {
      pairing = { ...res.json, code: pair.code, secret: pair.secret }
    } else {
      if (typeof res.json.code !== "string" || typeof res.json.secret !== "string" || !safeBrowserUrl(res.json.url)) {
        throw new Error("the server's answer was not understood")
      }
      pairing = res.json
    }
  } catch (err) {
    const why = err?.host ? `could not reach ${err.host}` : err instanceof Error ? err.message : String(err)
    return fail(`Could not start the Bonez setup: ${why}.`)
  }

  const { url, code, secret } = pairing
  const expiresAt = Number(pairing.expires_at) > 0 ? Number(pairing.expires_at) * 1000 : Date.now() + 30 * 60_000
  const pending = { code, secret, gateway: base, expiresAt, pollInterval: pairing.poll_interval, joining, opener: o.opener, createdAt: Date.now() }
  // Written down before anything else, so an answer given after this terminal is gone is still collected.
  writePending(pending)
  writeCanonical(progressPath(), { code, at: Date.now() })
  // Opened once per machine: the session-start hook does not open another page after this.
  const optin = readOptin()
  writeOptin({ ...optin, connectOpenedAt: optin.connectOpenedAt ?? Date.now() })
  let opened = false
  if (joining) {
    markConnect(o.nonce, { expiresAt })
    await say("Continue on the Bonez page in your browser.")
  } else {
    markConnect(o.nonce, { url, expiresAt })
    opened = o.open && openInBrowser(url)
    await say(opened ? `Opened the Bonez setup page in your browser: ${url}` : `Open this page in your browser to finish setting up Bonez: ${url}`)
  }

  // The hook's own background child is already detached: it polls itself.
  if (o.quiet) return waitForAnswer(pending, { nonce: o.nonce })

  view.finish({ joining, url, opened })
  if (joining) view.setLeaving("Setup goes on in the background and finishes when you answer in the browser.")
  else view.setLeaving("Setup goes on in the background and finishes when you answer in the browser:", url)
  return watchConnect(view, pending, { started: spawnWorker(["_connect-wait", code]) })
}

// install.sh's screen (1SI-4098): on a terminal, install.sh starts this first and tells it what it does, one
// line per change on stdin (tab-separated: `working NAME`, `tool STATE NAME WORD NEXT`, `detail TEXT`,
// `claude-app URL`, `fail TEXT`, `end CONNECT`), so the tool steps and the browser steps are one screen from the
// start. With `end 1` it goes on to `connect` (BONEZ_PAIR and BONEZ_GATEWAY_URL come from install.sh). A `detail`
// belongs to the last `tool` row sent; a `tool` row sent again under the same name replaces it and its details.
// A detail with an address in it (Codex's `Sign-in link: <url>`) stays on the screen and in the summary until
// that tool is signed in.
async function cmdInstallUi() {
  const view = await connectView()
  view.header()
  // Lines from install.sh, until `end` (or until it closes the pipe without one).
  async function* lines() {
    let buf = ""
    process.stdin.setEncoding("utf8")
    for await (const chunk of process.stdin) {
      buf += chunk
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        yield buf.slice(0, i)
        buf = buf.slice(i + 1)
      }
    }
    if (buf) yield buf
  }
  let end
  for await (const raw of lines()) {
    const [kind, ...f] = raw.split("\t")
    if (kind === "working") view.toolWorking(f[0])
    else if (kind === "tool") view.tool(f[0], f[1], f[2], f[3] || undefined)
    else if (kind === "detail") view.detail(f[0])
    else if (kind === "claude-app") view.claudeApp(f[0])
    else if (kind === "fail") {
      view.fail(f[0])
      process.exitCode = 1
    } else if (kind === "end") {
      end = { connect: f[0] === "1" }
      break
    }
  }
  if (!end) {
    view.fail("The installer stopped before it finished. Run it again.")
    process.exitCode = 1
    return
  }
  if (process.exitCode) return
  if (end.connect) return cmdConnect(["--opener", "installer"], view)
  if (process.env.BONEZ_PAIR) view.note("Go back to the Bonez page in your browser to finish.")
  view.allSet("Bonez is in your coding tools.")
  if (view.caps.live) await sleep(800)
}

async function connectView() {
  const { createView } = await import("./lib/connect-tui.mjs")
  return createView()
}

// The foreground: shows what the background helper reports, until it is done. Closing the terminal ends
// only this; Ctrl-C says the setup goes on. If no helper runs, this process polls itself.
async function watchConnect(view, p, { started }) {
  const { code } = p
  const t0 = Date.now()
  let takenOver = started ? undefined : waitForAnswer(p)
  // Ctrl-C, the window closing: the screen is given back with what is left to do (the full-screen view does it
  // itself); setup goes on in the background either way.
  if (!view.caps.live) {
    view.setLeaving("Stopped watching. Setup goes on in the background and finishes when you answer in the browser.")
    process.on("SIGINT", () => {
      view.end({ interrupted: true })
      process.exit(0)
    })
    process.on("SIGHUP", () => process.exit(0))
    process.on("SIGTERM", () => process.exit(0))
  }

  const shown = { claimed: false, tools: new Set(), answer: false, saved: false, backfill: false }
  view.waiting(`Waiting for you in the browser${view.caps.unicode ? "…" : "..."}`, p.expiresAt)
  for (;;) {
    await sleep(120)
    const pr = readProgress(code) ?? {}
    if (pr.claimed && !shown.claimed) {
      shown.claimed = true
      if (!p.joining) view.done("Signed in to Bonez in the browser")
    }
    for (const id of pr.tools ?? []) {
      if (shown.tools.has(id)) continue
      shown.tools.add(id)
      view.toolSignedIn(CONNECT_TOOL_LABELS[id] ?? id)
    }
    if (pr.answer && !shown.answer) {
      shown.answer = true
      if (!pr.answer.on) {
        view.stopLive()
        view.skipped("Session saving stays off", "Turn it on later in Settings > Bonez Plugin, or with /bonez:capture on")
      }
    }
    if (pr.saved && !shown.saved) {
      shown.saved = true
      view.stopLive()
      view.done("Session saving is on")
    }
    const bf = pr.backfill
    if (bf && !shown.backfill) {
      if (bf.skipped) {
        shown.backfill = true
        view.note("BONEZ_SESSION_SYNC=0 is set, so recent sessions were not added.")
      } else if (bf.added !== undefined) {
        shown.backfill = true
        view.stopLive()
        if (!bf.total) view.done("No recent sessions to add")
        else {
          const what = `recent session${bf.total === 1 ? "" : "s"}`
          view.done(bf.added === bf.total ? `Added ${bf.total} ${what}` : `Added ${bf.added} of ${bf.total} ${what}`, `from the last ${CONNECT_RECENT_DAYS} days`)
        }
        if (bf.added < bf.total) view.note(`${bf.total - bf.added} were skipped or failed. Try them again with: backfill --since-days=${CONNECT_RECENT_DAYS}`)
      } else if (bf.total) {
        view.progress(bf.done ?? 0, bf.total)
      }
    }
    if (pr.finished) {
      if (takenOver) await takenOver
      if (pr.error) {
        view.fail(pr.error)
        process.exitCode = 1
      } else if (pr.ok) view.allSet()
      else view.stopLive()
      // A moment on the finished screen before it is given back with its summary.
      if (view.caps.live) await sleep(800)
      return
    }
    // The helper died before it finished (or never said it started): this process polls instead. The
    // pairing is still written down, so a session start can finish it if this terminal closes too.
    if (!takenOver && Date.now() - t0 > WORKER_START_GRACE_MS && !(pidAlive(pr.pid) && Date.now() - (pr.heartbeatAt ?? 0) < POLLER_STALE_MS)) {
      takenOver = waitForAnswer({ ...p, ...(readPending()?.code === code ? {} : { expiresAt: 0 }) })
    }
  }
}

// Hook path, on a machine with no capture settings: open the setup page once (a detached
// `connect`), and say so in one line. Returns false when it did not run, so the offer can.
async function openConnectOnce(agent) {
  if (process.env.BONEZ_CAPTURE_OFFER === "0") return false
  const state = readOptin()
  if (state.connectOpenedAt || state.declinedAt || state.enabledAt) return false
  if (!captureGatewayAllowed(gatewayBaseUrl())) return false
  const nonce = newNonce()
  writeOptin({ ...state, connectOpenedAt: Date.now(), connect: { nonce } })
  if (!startConnectWorker({ opener: CONNECT_OPENER_FOR[agent] ?? "installer", nonce })) {
    const { connectOpenedAt: _at, connect: _c, ...rest } = readOptin()
    writeOptin(rest)
    return false
  }
  let url
  const deadline = Date.now() + OFFER_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(100)
    const c = readOptin().connect
    if (c?.nonce !== nonce) break
    if (c.url) {
      url = c.url
      break
    }
    if (c.error) return true // nothing to say; a later start offers capture instead
  }
  const lead = "Bonez opened a setup page in your browser to finish connecting."
  emitNotice(agent, url ? `${lead} If it did not open: ${url}` : `${lead} If it did not open, run ${captureCmd(agent, "on")}`)
  return true
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
  if (cfg.apiKey) return "API key configured"
  const oauth = cfg.oauth
  if (!oauth) return "(none — run `login`)"
  if (!oauth.expiresAt) return "OAuth"
  const mins = Math.round((oauth.expiresAt - Date.now()) / 60_000)
  const freshness = mins > 0 ? `token valid ${mins}m` : "token expired, refreshes on next upload"
  return `OAuth${oauth.refreshToken ? "" : " (no refresh token)"} — ${freshness}`
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
    `Where it goes: ${gatewayBaseUrl()} → your org's bonez import pipeline → the org's`,
    "System Model, as a searchable conversation record (same destination as the desktop app's manual import).",
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
      ? "Signed in with OAuth, scoped to session upload only — this credential cannot read the System Model."
      : "Using an API key. `login` swaps it for browser sign-in with no key on disk.",
  ].join("\n")
}

function cmdInstall(key, rest) {
  if (refuseForeignGateway("install")) return
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
  if (refuseForeignGateway("login")) return
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
    oauth: { ...tokens, gateway: gatewayBaseUrl() },
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

// A deliberate, human-run sweep of local Claude Code, Codex and Cursor history. NOT reachable from
// any hook: it publishes a large volume of past conversation to the org's System Model in one go, and
// that is a decision someone makes on purpose, once, not a side effect of opening a terminal.
//
// `--dry-run` first is the point of the default output — you should be able to see the size of
// what you are about to publish before any of it leaves the machine.
async function cmdBackfill(rest) {
  const args = rest ?? []
  const dryRun = args.includes("--dry-run")
  const limitArg = args.find((a) => a.startsWith("--limit="))
  const parsedLimit = limitArg ? Number.parseInt(limitArg.slice("--limit=".length), 10) : Number.NaN
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : CLAUDE_BACKFILL_BATCH
  const agentArg = args.find((a) => a.startsWith("--agent="))?.slice("--agent=".length)
  if (agentArg && !BACKFILL_AGENTS.includes(agentArg)) {
    console.error(`--agent must be one of: ${BACKFILL_AGENTS.join(", ")}`)
    process.exitCode = 1
    return
  }
  const agents = agentArg ? [agentArg] : BACKFILL_AGENTS
  const sinceArg = args.find((a) => a.startsWith("--since-days="))
  const sinceDays = sinceArg ? Number.parseInt(sinceArg.slice("--since-days=".length), 10) : 0
  if (sinceArg && !(Number.isFinite(sinceDays) && sinceDays > 0)) {
    console.error("--since-days must be a whole number of days, 1 or more")
    process.exitCode = 1
    return
  }
  const since = sinceDays ? Date.now() - sinceDays * DAY_MS : 0

  if (disabledByEnv()) {
    console.error("BONEZ_SESSION_SYNC=0 is set — unset it before running a backfill.")
    process.exitCode = 1
    return
  }
  const cfg = loadConfig()
  if (!cfg || !cfg.enabled || !hasCredential(cfg)) {
    console.error("Session capture is not on. Run `on` (or `login --global`) first.")
    process.exitCode = 1
    return
  }

  // One list across every harness, newest first, so a run sends the most recent work wherever it ran.
  const names = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" }
  const { perAgent, targets } = allBackfillTargets(agents, loadState(), since)
  const unreadable = agents.includes("codex") ? unreadableCodexRollouts() : 0
  if (unreadable) console.log(zstdNotice(unreadable))
  if (!targets.length) {
    console.log("Nothing to backfill: every session on this machine is already uploaded at its current content.")
    return
  }

  const batch = targets.slice(0, limit)
  console.log(`Sessions not yet uploaded at their current content: ${targets.length}`)
  for (const { agent, targets: ts } of perAgent) if (ts.length) console.log(`  ${names[agent]}: ${ts.length}`)
  console.log(`This run ${dryRun ? "would upload" : "uploads"} ${batch.length} of them (newest first):`)
  for (const t of batch) console.log(`  ${new Date(t.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${names[t.agent].padEnd(11)} ${t.sessionId}`)
  if (targets.length > batch.length) {
    console.log(`Re-run to continue; each run picks up where the last one stopped.`)
  }
  if (dryRun) {
    console.log("")
    console.log("--dry-run: nothing was uploaded. Drop the flag to publish these to your org's System Model.")
    return
  }

  console.log("")
  let uploaded = 0
  for (const [i, t] of batch.entries()) {
    process.stdout.write(`  [${i + 1}/${batch.length}] ${t.sessionId} … `)
    try {
      // Sequential and one-at-a-time on purpose: every upload writes sync-state, so an
      // interrupt (Ctrl-C, a dropped network) leaves everything already done recorded as done
      // and the rest simply not started. That is what makes re-running safe.
      if (await uploadOne({ agent: t.agent, cfg, sessionId: t.sessionId, transcriptPath: t.transcriptPath })) {
        uploaded++
        console.log("ok")
      } else {
        console.log("skipped (see the log)")
      }
    } catch (err) {
      // One unreadable or rejected transcript must not end the sweep — the whole value here is
      // draining a backlog unattended. sync.log carries the detail.
      console.log(`failed (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  console.log("")
  console.log(`Done: ${uploaded}/${batch.length} uploaded. See ${logFilePath()} for per-session detail.`)
}

// Where the hook reads its settings, in words.
function describeDataDir() {
  const dir = dataDir()
  const hostDir = process.env.CLAUDE_PLUGIN_DATA
  const found = existsSync(join(dir, "config.json"))
  if (process.env.BONEZ_SESSION_SYNC_DATA) return `${dir} (set by BONEZ_SESSION_SYNC_DATA)`
  if (!found) return `${dir} (no settings there)`
  if (dir === hostDir) return `${dir} (settings found there)`
  return `${dir} (settings found through the fallback${hostDir ? `; the Claude Code folder ${hostDir} has none` : ""})`
}

// What `status` cannot see from a plain shell: the server address the Claude Code hook uses
// (the plugin option is only in the hooks' environment), and whether the sign-in matches it.
function hookGatewayLines(cfg) {
  const lines = []
  const hook = process.env.CLAUDE_PLUGIN_OPTION_BONEZ_URL ? undefined : readJsonSafe(hookFolderPath(), null)
  const used = typeof hook?.gateway === "string" ? hook.gateway : gatewayBaseUrl()
  if (used !== gatewayBaseUrl()) lines.push(`  the Claude Code hook uses: ${used} (from ${hook.gatewaySource ?? "its own environment"})`)
  const mismatch = signInMismatch(cfg, used)
  if (mismatch) lines.push(`  sign-in:  issued by ${mismatch.signedIn}, not ${mismatch.target}: uploads are not sent until you sign in again or change the server address`)
  return lines
}

const when = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"

function cmdStatus() {
  // Answer for the folder the Claude Code hook reads, from a plain shell too.
  if (!process.env.CLAUDE_PLUGIN_DATA && !process.env.BONEZ_SESSION_SYNC_DATA) {
    const seen = readJsonSafe(hookFolderPath(), null)?.claude
    if (typeof seen === "string" && seen) {
      process.env.CLAUDE_PLUGIN_DATA = seen
      _dataDir = undefined
    }
  }
  reportMigration()
  const cfg = loadConfig()
  if (!cfg) {
    console.log("bonez session capture: not installed.")
    console.log(`  hook reads: ${describeDataDir()}`)
    for (const d of strandedSettings()) console.log(`  settings also in ${d}, which the hook does not read`)
    console.log("Run: bonez-session-sync.mjs login [--repo <path>]... [--global]")
    console.log("  (headless, no browser: install <bnz_...key> with the same options)")
    return
  }
  const state = loadState()
  const attempt = readJsonSafe(healthPath(), {}).attempts?.at(-1)
  const lastOk = lastSuccessAt()
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
    `  gateway:  ${gatewayBaseUrl()} (from ${gatewaySource()})`,
    ...hookGatewayLines(cfg),
    `  clients:  Claude Code, Codex, Cursor (one sign-in, shared store)`,
    `  sessions synced: ${Object.keys(state).length}`,
    `  installed:${cfg.installedAt ?? "unknown"}`,
    `  hook reads: ${describeDataDir()}`,
    `  last upload attempt: ${attempt ? `${when(attempt.at)} — ${attempt.ok ? "OK" : `failed: ${attempt.step} to ${attempt.host}: ${attempt.detail}`}` : "none recorded"}`,
    `  last successful upload: ${lastOk ? when(lastOk) : "never"}`,
    `  log:      ${logFilePath()}`,
  )
  const unreadable = unreadableCodexRollouts()
  if (unreadable) lines.push(`  ${zstdNotice(unreadable)}`)
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
    case "_optin":
      try {
        await cmdOptinWorker(rest[0])
      } catch {
        /* logged inside; a detached worker has nobody to tell */
      }
      process.exit(0)
      break
    case "decline":
      cmdDecline()
      break
    case "on":
      await cmdOn()
      break
    // install.sh (bonez-core, mcp_install_assets) finds out what this plugin can do by grepping this file for
    // `case "connect":` and `case "install-ui":`. Keep those two lines exactly as they are (tests pin them).
    case "connect":
      try {
        await cmdConnect(rest)
      } catch (err) {
        if (rest.includes("--quiet")) await log(`connect: ${err instanceof Error ? err.message : String(err)}`)
        else {
          const why = `Could not finish the Bonez setup: ${err instanceof Error ? err.message : String(err)}`
          const { activeView } = await import("./lib/connect-tui.mjs")
          if (activeView()) activeView().fail(why)
          else console.error(why)
        }
        process.exitCode = 1
      }
      // An idle keep-alive socket would hold the process open for seconds after the last line.
      process.exit(process.exitCode ?? 0)
      break
    case "install-ui":
      try {
        await cmdInstallUi()
      } catch (err) {
        const { activeView } = await import("./lib/connect-tui.mjs")
        const why = `Could not finish the Bonez setup: ${err instanceof Error ? err.message : String(err)}`
        if (activeView()) activeView().fail(why)
        else console.error(why)
        process.exitCode = 1
      }
      process.exit(process.exitCode ?? 0)
      break
    case "_connect-wait":
    case "_connect-backfill":
      try {
        if (cmd === "_connect-wait") await cmdConnectWaitWorker(rest[0])
        else await cmdConnectBackfillWorker()
      } catch (err) {
        await log(`connect: ${err instanceof Error ? err.message : String(err)}`)
      }
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
    case "_presence":
      try {
        await cmdPresence(rest[0])
      } catch (err) {
        await log(`presence: uncaught error: ${err instanceof Error ? err.message : String(err)}`)
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
    case "backfill":
      await cmdBackfill(rest)
      return
    default:
      console.log("bonez-session-sync — capture Claude Code, Codex and Cursor sessions into bonez")
      console.log("")
      console.log("usage:")
      console.log("  bonez-session-sync.mjs connect [--opener <tool>] [--no-open] [--detach] [--pair CODE.SECRET]")
      console.log("                                                                  set up Bonez in the browser")
      console.log("  bonez-session-sync.mjs connect --demo [--joining] [--until=adding|tools|waiting|signin|backfill|done]")
      console.log("                                                                  preview the installer's screen")
      console.log("  bonez-session-sync.mjs install-ui                               the installer's screen: install.sh's events on stdin,")
      console.log("                                                                  then `connect` on the same screen")
      console.log("  bonez-session-sync.mjs on                                       one-click sign-in link, every repo")
      console.log("  bonez-session-sync.mjs decline                                  off, and never ask again")
      console.log("  bonez-session-sync.mjs login [--repo <path>]... [--global]     browser sign-in")
      console.log("  bonez-session-sync.mjs logout")
      console.log("  bonez-session-sync.mjs install <bnz_...key> [--repo <path>]... [--global]")
      console.log("                                                                  headless lane")
      console.log("  bonez-session-sync.mjs status")
      console.log("  bonez-session-sync.mjs disable")
      console.log("  bonez-session-sync.mjs enable")
      console.log("  bonez-session-sync.mjs backfill [--dry-run] [--limit=N] [--agent=claude|codex|cursor] [--since-days=N]")
      console.log("                                                                  upload past sessions")
      process.exitCode = !cmd || ["--help", "-h", "help"].includes(cmd) ? 0 : 1
  }
}

// Only dispatch when this file is run directly (`node bin/bonez-session-sync.mjs ...`), not
// when a test imports it as an ES module to unit-test the pure helpers below.
//
// Compared as real file paths, not as `file://` strings. The string compare this replaces was
// `import.meta.url === \`file://${process.argv[1]}\``, which is never true on Windows
// (`file:///C:/x/y.mjs` against `C:\x\y.mjs`): main() never ran there, so every hook and every
// `login` exited 0 having done nothing. It was also false whenever the script was reached through a
// symlink or a path with a character a URL escapes (a space, `#`, `%`).
const isMain = (() => {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(SELF_PATH)
  } catch {
    return false
  }
})()
if (isMain) await main()

export {
  announceSession,
  announcedSessionId,
  takePresenceLock,
  describeFailure,
  isSidechainTranscript,
  buildBundle,
  inCaptureScope,
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
  codexRollouts,
  normalizeCodexLine,
  parseCodexRollout,
  findCursorCatchupTargets,
  findClaudeCatchupTargets,
  findClaudeBackfillTargets,
  staleTranscriptTargets,
  cursorProjectSlug,
  claudeProjectSlug,
  cmdBackfill,
  detectTools,
  safeBrowserUrl,
  gatewayBaseUrl,
  recordUpload,
  withStateLock,
  parseCursorFile,
  resolveTranscriptPath,
  wireAgentFor,
  workspaceRootFrom,
  shouldSkip,
}
