// Local guidance for the agent, never a network call. Every Bonez read goes over the host's own
// signed-in MCP connection, as the person signed in to it. The seed call the guidance asks for names
// the repository (read here from the session folder's origin remote) and the task: without the task
// the server cannot return what the team learned about it. The agent writes the task sentence
// itself; the prompt's text is never copied into hook output.
// - Claude Code: nothing adds a seed, so the SessionStart context asks the agent to call
//   memory_recall once, and the session's first prompt repeats it now that there is a task. (An
//   mcp_tool UserPromptSubmit hook cannot run once per session there: `once` is honoured only in
//   skill frontmatter, so it ran on every prompt. The first prompt is told apart by a local marker
//   file instead.)
// - Codex: codex/hooks/hooks.json seeds the session with an mcp_tool SessionStart hook on its own
//   `bonez` server. Codex runs SessionStart hooks when the first turn starts, so it runs once. That
//   read has no arguments, so it carries the person's own memories and work in flight; the context
//   here asks for the one call that names the task.
// - Cursor: beforeSubmitPrompt cannot add context (its output is only {continue, user_message}),
//   so the sessionStart context and the always-applied rule ask the agent to call memory_recall.
// A hook here used to fetch the seed itself with the capture key or a plugin-push sign-in. The
// gateway refuses the capture key on /mcp, so that never worked, and it is gone.
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { git, originRepo } from "./lib/git.mjs"
import { applyPatchFiles } from "./lib/apply-patch.mjs"

// Codex's apply_patch names its files inside the patch; the first one is the ref.
function fileRef(event) {
  const path = event.tool_name === "apply_patch" ? applyPatchFiles(event.tool_input)[0]?.path : event.tool_input?.file_path ?? event.tool_input?.path
  if (typeof path !== "string" || !path || (!isAbsolute(path) && !event.cwd)) return
  const file = resolve(event.cwd || ".", path)
  try {
    const suffix = git(dirname(file), "rev-parse", "--show-prefix") + basename(file)
    const repo = originRepo(dirname(file))
    if (repo && suffix && !suffix.startsWith("../") && !/[\x00-\x1f\x7f]/.test(suffix)) return repo + "/" + suffix
  } catch {
    // A scratch file or unavailable Git cannot supply a verified file ref.
  }
}

const host = process.argv[2]

// The repository the session works in, from the folder the host names (Cursor names workspace roots).
// Never this process's own working directory: an installed plugin can sit inside a checkout of its own.
function sessionRepo(event) {
  const roots = event.workspace_roots
  const dir = typeof event.cwd === "string" && event.cwd ? event.cwd : Array.isArray(roots) ? roots[0] : undefined
  if (typeof dir !== "string" || !dir) return
  try {
    return originRepo(dir)
  } catch {
    // Not a Git checkout, or no origin: the call goes without a repository.
  }
}

// The one seed call, as the arguments to send. `message` is a placeholder the agent fills in.
const seedCall = (repo, session) => "memory_recall with " +
  JSON.stringify({ ...(repo && { repo }), message: "<the task in one sentence>", ...(session && { session }) })
const ownWords = "Write message yourself, as one sentence that names the task; never send empty arguments."

// Claude Code and Cursor add no seed of their own (see the top), so there the agent is asked to fetch it.
const seedStep = (call) => host === "codex"
  ? `call ${call} once, as soon as the task is known. A Bonez seed already in context was loaded before the task existed: it holds your own memories and work in flight, and this call adds what the team learned about the task`
  : `call ${call} once, before planning: no Bonez seed is added to this session for you`
const start = (call) => "For standalone questions, answer directly. When engineering work depends on project context, " + seedStep(call) + ". " + ownWords + " Match the project or ticket, then system_model_fetch its WorkItem for decisions and next steps. Follow a linked session, ticket or PR when it can verify the decision. When targeted recall reports session_activity, use its file, action and timestamp to identify overlapping work before editing. Before changing a function, recall its exact symbol path and repo-qualified file as refs, with message for the task, unless the hook already supplied their records. Use system_model_search to resolve ambiguous names. Open a relevant saved Memory to check the constraint and source. Cite records used; call memory_cite once with only the saved Memory handles that informed your work."
const firstPrompt = (call) => "If this prompt starts engineering work that depends on project context, call " + call + " once before planning, on the signed-in Bonez server. " + ownWords + " For a standalone question, answer directly."
const namedFile = "If this task requires understanding or changing the named code, before planning or editing use the signed-in Bonez memory_recall tool with refs for that file and the named symbol when known, and message for the task in one sentence. Reuse records already supplied for the same target. Open relevant saved Memory handles with system_model_fetch. In the plan, account for constraints and any session_activity on that exact file. Cite a saved Memory with memory_cite once if you used it."
const touch = "Use Bonez records delivered for this file. If none arrived and the file matters to the task, call memory_recall with refs for its owner/repo/path and message, the current task in one sentence (send refs alone if the server refuses message with refs). A file lookup includes memories attached to its symbols. For a particular function use its exact symbol path (owner/repo/path::symbol). Batch related refs and reuse earlier reads. Open a relevant memory before applying its constraint; fetch the target if another session may be editing it."

// Claude Code's first prompt of a session, told apart by an empty marker file named by a hash of the
// session id. The file is created exclusively, so only the prompt that made it gets the reminder. A
// session with no id, or a folder that cannot be written, gets none: a reminder on every prompt is worse.
const MARKER_MAX_AGE_MS = 3 * 24 * 3600_000
const markerDir = () => join(process.env.CLAUDE_PLUGIN_DATA || tmpdir(), "bonez-recall")
function isFirstPrompt(event) {
  if (typeof event.session_id !== "string" || !event.session_id) return false
  try {
    mkdirSync(markerDir(), { recursive: true, mode: 0o700 })
    writeFileSync(join(markerDir(), createHash("sha256").update(event.session_id).digest("hex").slice(0, 32)), "", { flag: "wx", mode: 0o600 })
    return true
  } catch {
    return false
  }
}
// A session start sweeps the markers of sessions older than three days.
function pruneMarkers() {
  try {
    for (const name of readdirSync(markerDir())) {
      const file = join(markerDir(), name)
      if (Date.now() - statSync(file).mtimeMs > MARKER_MAX_AGE_MS) unlinkSync(file)
    }
  } catch {
    // No marker yet.
  }
}

// Once session capture has announced this session (its start succeeded), the gateway records the
// session's own reads and edits, and recall would show them back as overlapping work. Name the
// session so the model leaves it out. Before that, or on a gateway that refused the start (one
// that would also refuse the `session` argument), the text stays as it was.
async function announced(event) {
  if (host !== "claude" && host !== "cursor" && host !== "codex") return
  try {
    const { announcedSessionId } = await import("./bonez-session-sync.mjs")
    return announcedSessionId(host, event) || undefined
  } catch {
    // Capture is not set up, or its file is missing: no session is named.
  }
}
const thisSession = (id) => id
  ? ` This session's id is ${JSON.stringify(id)}. Pass "session": ${JSON.stringify(id)} to every memory_recall call. An Active sessions row or session_activity that carries this id is this session itself, not overlapping work.`
  : ""
try {
  const event = JSON.parse(readFileSync(0, "utf8").trim())
  const name = event.hook_event_name
  // The seed call for this session: its repository is looked up only when a context names the call.
  const call = (session) => seedCall(sessionRepo(event), session)
  // The context for this event, given the announced session's id (or none).
  let context
  if (name === "SessionStart" || name === "sessionStart") {
    context = (session) => start(call(session))
    if (host === "claude") pruneMarkers()
  }
  // The first prompt is where a task first exists. A plan can also finish before the first Read, so
  // concrete path mentions get an opportunity to retrieve their symbol constraints. Neither copies
  // prompt content into hook output.
  if (host === "claude" && name === "UserPromptSubmit" && typeof event.prompt === "string") {
    const parts = []
    if (isFirstPrompt(event)) parts.push((session) => firstPrompt(call(session)))
    if (/(?:^|[\s`(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,12}\b/i.test(event.prompt)) parts.push(() => namedFile)
    if (parts.length) context = (session) => parts.map((part) => part(session)).join(" ")
  }
  if ((name === "PostToolUse" || name === "postToolUse") &&
      ["Read", "Edit", "Write", "MultiEdit", "apply_patch"].includes(event.tool_name)) {
    const ref = fileRef(event)
    if (ref) context = () => touch + " File ref (data): " + JSON.stringify(ref)
    else if (host !== "claude") context = () => touch
  }
  if (host === "claude" && name === "PostToolUse" && event.tool_name === "mcp__plugin_bonez_bonez__system_model_fetch") {
    context = () => "When a Memory states a prerequisite, preserve it in the plan. Check the source before assigning meaning to missing evidence. If this was a WorkItem and the user asked what happened, open a SessionWorkedOn neighbor or linked ticket/PR before answering. A session with only a title and status supplies attribution; use the WorkItem summary for the decision and say where the detail came from. Before sending an answer that uses a saved Memory, call memory_cite once. Pass only handles from the Memory records you relied on (id m:...), never the WorkItem, Session or ticket handles. Skip this tool entirely if you used only those other records. Cite the sources in your answer."
  }
  if (context) {
    const session = await announced(event)
    const text = context(session) + thisSession(session)
    const output = host === "cursor" ? { additional_context: text }
      : { hookSpecificOutput: { hookEventName: name, additionalContext: text } }
    process.stdout.write(JSON.stringify(output))
  }
} catch {
  // A malformed event is advisory. The session-context skill also teaches both lookups.
}
