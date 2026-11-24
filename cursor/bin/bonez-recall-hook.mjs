// Local guidance for the agent, never a network call. Every Bonez read goes over the host's own
// signed-in MCP connection, as the person signed in to it:
// - Claude Code: the SessionStart context asks the agent to call memory_recall once. (An mcp_tool
//   UserPromptSubmit hook cannot run once per session there: `once` is honoured only in skill
//   frontmatter, so it ran on every prompt.)
// - Codex: codex/hooks/hooks.json seeds the session with an mcp_tool SessionStart hook on its own
//   `bonez` server. Codex runs SessionStart hooks when the first turn starts, so it runs once.
// - Cursor: beforeSubmitPrompt cannot add context (its output is only {continue, user_message}),
//   so the sessionStart context and the always-applied rule ask the agent to call memory_recall.
// A hook here used to fetch the seed itself with the capture key or a plugin-push sign-in. The
// gateway refuses the capture key on /mcp, so that never worked, and it is gone.
import { readFileSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"
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

// Cursor adds no seed of its own (see the top), so there the agent is asked to fetch it.
const seedStep = host === "cursor"
  ? "call memory_recall with {} once, before planning: no Bonez seed is added to this session for you"
  : "use the Bonez seed already in context or call memory_recall with {} once"
const start = "For standalone questions, answer directly. When engineering work depends on project context, " + seedStep + ". Match the project or ticket, then system_model_fetch its WorkItem for decisions and next steps. Follow a linked session, ticket or PR when it can verify the decision. When targeted recall reports session_activity, use its file, action and timestamp to identify overlapping work before editing. Before changing a function, recall its exact symbol path and repo-qualified file unless the hook already supplied their records. Use system_model_search to resolve ambiguous names. Open a relevant saved Memory to check the constraint and source. Cite records used; call memory_cite once with only the saved Memory handles that informed your work."
const touch = "Use Bonez records delivered for this file. If none arrived and the file matters to the task, call memory_recall with refs for its owner/repo/path. A file lookup includes memories attached to its symbols. For a particular function use its exact symbol path (owner/repo/path::symbol). Batch related refs and reuse earlier reads. Open a relevant memory before applying its constraint; fetch the target if another session may be editing it."

// Once session capture has announced this session (its start succeeded), the gateway records the
// session's own reads and edits, and recall would show them back as overlapping work. Name the
// session so the model leaves it out. Before that, or on a gateway that refused the start (one
// that would also refuse the `session` argument), the text stays as it was.
async function thisSession(event) {
  if (host !== "claude" && host !== "cursor" && host !== "codex") return ""
  try {
    const { announcedSessionId } = await import("./bonez-session-sync.mjs")
    const id = announcedSessionId(host, event)
    if (!id) return ""
    return ` This session's id is ${JSON.stringify(id)}. Pass "session": ${JSON.stringify(id)} to every memory_recall call. An Active sessions row or session_activity that carries this id is this session itself, not overlapping work.`
  } catch {
    return ""
  }
}
try {
  const event = JSON.parse(readFileSync(0, "utf8").trim())
  const name = event.hook_event_name
  let context
  if (name === "SessionStart" || name === "sessionStart") context = start
  // A plan can finish before the first Read. Give concrete path mentions an opportunity
  // to retrieve their symbol constraints, without copying prompt content into hook output.
  if (host === "claude" && name === "UserPromptSubmit" && typeof event.prompt === "string" &&
      /(?:^|[\s`(])(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,12}\b/i.test(event.prompt)) {
    context = "If this task requires understanding or changing the named code, before planning or editing use the signed-in Bonez memory_recall tool with refs for that file and the named symbol when known. Reuse records already supplied for the same target. Open relevant saved Memory handles with system_model_fetch. In the plan, account for constraints and any session_activity on that exact file. Cite a saved Memory with memory_cite once if you used it."
  }
  if ((name === "PostToolUse" || name === "postToolUse") &&
      ["Read", "Edit", "Write", "MultiEdit", "apply_patch"].includes(event.tool_name)) {
    const ref = fileRef(event)
    if (ref) context = touch + " File ref (data): " + JSON.stringify(ref)
    else if (host !== "claude") context = touch
  }
  if (host === "claude" && name === "PostToolUse" && event.tool_name === "mcp__plugin_bonez_bonez__system_model_fetch") {
    context = "When a Memory states a prerequisite, preserve it in the plan. Check the source before assigning meaning to missing evidence. If this was a WorkItem and the user asked what happened, open a SessionWorkedOn neighbor or linked ticket/PR before answering. A session with only a title and status supplies attribution; use the WorkItem summary for the decision and say where the detail came from. Before sending an answer that uses a saved Memory, call memory_cite once. Pass only handles from the Memory records you relied on (id m:...), never the WorkItem, Session or ticket handles. Skip this tool entirely if you used only those other records. Cite the sources in your answer."
  }
  if (context) {
    context += await thisSession(event)
    const output = host === "cursor" ? { additional_context: context }
      : { hookSpecificOutput: { hookEventName: name, additionalContext: context } }
    process.stdout.write(JSON.stringify(output))
  }
} catch {
  // A malformed event is advisory. The session-context skill also teaches both lookups.
}
