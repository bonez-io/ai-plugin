// Hooks run before the host's OAuth MCP connection is necessarily ready. Hand the lookup
// to the agent on that connection. This command handles no network access or credentials.
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { basename, dirname, isAbsolute, resolve } from "node:path"

function fileRef(event) {
  const path = event.tool_input?.file_path ?? event.tool_input?.path
  if (typeof path !== "string" || !path || (!isAbsolute(path) && !event.cwd)) return
  const file = resolve(event.cwd || ".", path)
  const git = (...args) => execFileSync("git", ["-C", dirname(file), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600, maxBuffer: 8192,
  }).trim()
  try {
    const suffix = git("rev-parse", "--show-prefix") + basename(file)
    const origin = git("config", "--get", "remote.origin.url").replace(/\/$/, "").replace(/\.git$/, "")
    const repo = /^(?:https:\/\/|ssh:\/\/git@|git@)[a-zA-Z0-9.-]+[:/]([\w.-]+(?:\/[\w.-]+)+)$/.exec(origin)?.[1]
    if (repo && suffix && !suffix.startsWith("../") && !/[\x00-\x1f\x7f]/.test(suffix)) return repo + "/" + suffix
  } catch {
    // A scratch file or unavailable Git cannot supply a verified graph ref.
  }
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
