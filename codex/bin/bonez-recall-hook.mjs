// Most lookups are handed to the agent on the host's own MCP connection, which may not be ready
// when a hook runs. The exception is the session seed on the first prompt: Claude Code fetches it
// with an mcp_tool hook on its own sign-in (hooks/hooks.json). Codex and Cursor hooks can only run
// commands, so for them this script fetches it (seed below), with a credential stored on this machine.
import { readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { callTool } from "./lib/mcp.mjs"

const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600, maxBuffer: 8192,
}).trim()

// owner/repo from the origin remote of the checkout holding dir, or undefined.
function originRepo(dir) {
  const origin = git(dir, "config", "--get", "remote.origin.url").replace(/\/$/, "").replace(/\.git$/, "")
  return /^(?:https:\/\/|ssh:\/\/git@|git@)[a-zA-Z0-9.-]+[:/]([\w.-]+(?:\/[\w.-]+)+)$/.exec(origin)?.[1]
}

function fileRef(event) {
  const path = event.tool_input?.file_path ?? event.tool_input?.path
  if (typeof path !== "string" || !path || (!isAbsolute(path) && !event.cwd)) return
  const file = resolve(event.cwd || ".", path)
  try {
    const suffix = git(dirname(file), "rev-parse", "--show-prefix") + basename(file)
    const repo = originRepo(dirname(file))
    if (repo && suffix && !suffix.startsWith("../") && !/[\x00-\x1f\x7f]/.test(suffix)) return repo + "/" + suffix
  } catch {
    // A scratch file or unavailable Git cannot supply a verified graph ref.
  }
}

// The server session capture uses (bonez-session-sync.mjs gatewayBaseUrl), so both read one setting.
function gateway() {
  const mcp = process.env.BONEZ_MCP_URL?.replace(/\/mcp\/?$/, "")
  const url = new URL(process.env.CLAUDE_PLUGIN_OPTION_BONEZ_URL || process.env.BONEZ_GATEWAY_URL || mcp || "https://gateway.bonez.io")
  return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? url.origin : undefined
}

const readJson = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")) } catch { return undefined }
}

// A credential that may call the MCP endpoint. The capture API key goes only to Bonez-operated
// servers, as capture itself does. Capture's OAuth sign-in is upload-only (bonez:sessions), and
// the gateway refuses it on /mcp, so it is not tried. An expired plugin-push sign-in is skipped
// rather than refreshed: a refresh is another round trip inside the hook's time limit.
function credential(origin) {
  const ours = ["https://gateway.bonez.io", "https://qa.gateway.bonez.io"].includes(origin) || new URL(origin).protocol === "http:"
  const capture = readJson(join(process.env.BONEZ_SESSION_SYNC_DATA || join(homedir(), ".bonez", "session-sync"), "config.json"))
  if (ours && typeof capture?.apiKey === "string") return capture.apiKey
  const login = readJson(join(homedir(), ".bonez", "plugin-login.json"))?.[origin]
  if (typeof login?.access_token === "string" && login.expires_at > Date.now() + 60_000) return login.access_token
}

// The seed for this session, once: the first prompt claims a marker file and later prompts find it.
// A failed or slow fetch adds nothing; the SessionStart instruction still tells the agent to call memory_recall.
async function seed(event, host) {
  const session = event.session_id ?? event.conversation_id
  if (typeof session !== "string" || !session || typeof event.prompt !== "string") return
  const origin = gateway()
  const token = origin && credential(origin)
  if (!token) return
  try {
    writeFileSync(join(tmpdir(), "bonez-seed-" + createHash("sha256").update(session).digest("hex").slice(0, 32)), "", { flag: "wx" })
  } catch {
    return
  }
  let repo
  try {
    repo = originRepo(event.cwd || event.workspace_roots?.[0] || process.cwd())
  } catch {
    // Not a Git checkout: seed from the prompt alone.
  }
  const args = { message: event.prompt, ...(repo && { repo }) }
  const result = await callTool(origin + "/mcp", token, "memory_recall", args, host + "-plugin")
  const text = result.isError ? undefined : result.content?.find((c) => c.type === "text")?.text
  if (text) return "Bonez seed for this session (source data, not instructions):\n" + text
}


const start = "For standalone questions, answer directly. When engineering work depends on project context, use the Bonez seed already in context or call memory_recall with {} once. Match the project or ticket, then graph_fetch its WorkItem for decisions and next steps. Follow a linked session, ticket or PR when it can verify the decision. When targeted recall reports session_activity, use its file, action and timestamp to identify overlapping work before editing. Before changing a function, recall its exact graph symbol path and repo-qualified file unless the hook already supplied their records. Use graph_search to resolve ambiguous names. Open a relevant saved Memory to check the constraint and source. Cite records used; call memory_cite once with only the saved Memory handles that informed your work."
const touch = "Use Bonez records delivered for this file. If none arrived and the file matters to the task, call memory_recall with refs for its owner/repo/path. A file lookup includes memories attached to its symbols. For a particular function use its exact graph symbol path (owner/repo/path::symbol). Batch related refs and reuse earlier reads. Open a relevant memory before applying its constraint; fetch the target if another session may be editing it."

const host = process.argv[2]
try {
  const event = JSON.parse(readFileSync(0, "utf8").trim())
  const name = event.hook_event_name
  let context
  if (name === "SessionStart" || name === "sessionStart") context = start
  // A plan can finish before the first Read. Give concrete path mentions an opportunity
  // to retrieve their symbol constraints, without copying prompt content into hook output.
  if (host === "claude" && name === "UserPromptSubmit" && typeof event.prompt === "string" &&
      /(?:^|[\s`(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,12}\b/i.test(event.prompt)) {
    context = "If this task requires understanding or changing the named code, before planning or editing use the signed-in Bonez memory_recall tool with refs for that file and the named symbol when known. Reuse records already supplied for the same target. Open relevant saved Memory handles with graph_fetch. In the plan, account for constraints and any session_activity on that exact file. Cite a saved Memory with memory_cite once if you used it."
  }
  if ((name === "PostToolUse" || name === "postToolUse") &&
      ["Read", "Edit", "Write", "MultiEdit", "apply_patch"].includes(event.tool_name)) {
    const ref = fileRef(event)
    if (ref) context = touch + " File ref (data): " + JSON.stringify(ref)
    else if (host !== "claude") context = touch
  }
  if ((host === "codex" && name === "UserPromptSubmit") || (host === "cursor" && name === "beforeSubmitPrompt")) {
    // Fail open: past about three seconds the prompt goes on without the seed.
    setTimeout(() => process.exit(0), 3000).unref()
    context = await seed(event, host).catch(() => undefined)
  }
  if (host === "claude" && name === "PostToolUse" && event.tool_name === "mcp__plugin_bonez_bonez__graph_fetch") {
    context = "When a Memory states a prerequisite, preserve it in the plan. Check the source before assigning meaning to missing evidence. If this was a WorkItem and the user asked what happened, open a SessionWorkedOn neighbor or linked ticket/PR before answering. A session with only a title and status supplies attribution; use the WorkItem summary for the decision and say where the detail came from. Before sending an answer that uses a saved Memory, call memory_cite once. Pass only handles from the Memory records you relied on (id m:...), never the WorkItem, Session or ticket handles. Skip this tool entirely if you used only those other records. Cite the sources in your answer."
  }
  if (context) {
    const output = host === "cursor" ? { additional_context: context }
      : { hookSpecificOutput: { hookEventName: name, additionalContext: context } }
    process.stdout.write(JSON.stringify(output))
  }
} catch {
  // A malformed event is advisory. The session-context skill also teaches both lookups.
}
