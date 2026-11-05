// Hooks run before the host's OAuth MCP connection is necessarily ready. Hand the lookup
// to the agent on that connection. This command handles no network access or credentials.
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

function fileRef(event) {
  const path = event.tool_input?.file_path ?? event.tool_input?.path
  if (typeof path !== "string" || !path || (!isAbsolute(path) && !event.cwd)) return
  const file = resolve(event.cwd || ".", path)
  const git = (...args) => execFileSync("git", ["-C", dirname(file), ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600, maxBuffer: 8192,
  }).trim()
  try {
    const suffix = relative(git("rev-parse", "--show-toplevel"), file).split(sep).join("/")
    const origin = git("config", "--get", "remote.origin.url")
    const repo = /^(?:https:\/\/|ssh:\/\/git@|git@)[a-zA-Z0-9.-]+[:/]([\w.-]+(?:\/[\w.-]+)+?)\/?(?:\.git)?$/.exec(origin)?.[1]
    if (repo && suffix && !suffix.startsWith("../") && !/[\x00-\x1f\x7f]/.test(suffix)) return repo + "/" + suffix
  } catch {
    // A scratch file or unavailable Git cannot supply a verified graph ref.
  }
}


const start = "For substantive work in this workspace, use the Bonez seed delivered at startup, or call the signed-in Bonez memory_recall tool with {} once before planning if no seed arrived. Read the relevant WorkItem's living summary with graph_fetch, then follow the linked session or tracker record for the decision and its evidence. When a specific ticket, PR or file becomes relevant, recall its refs. Use repo-qualified paths. If the server predates memory_recall, search and fetch those nodes and inspect their attached memories. Respect access errors. Cite sources for decisions you rely on; call memory_cite once with only memory handles actually used."
const touch = "If Bonez records for this file arrived from the hook, use those. Otherwise, for a relevant file you have not already checked, call Bonez memory_recall with refs containing its owner/repo/path. Batch related files or the task ticket together. Fetch the relevant WorkItem or memory and check the underlying source before acting. Use graph_search and graph_fetch on an older server."

const host = process.argv[2]
try {
  const event = JSON.parse(readFileSync(0, "utf8").trim())
  const name = event.hook_event_name
  let context
  if (name === "SessionStart" || name === "sessionStart") context = start
  if ((name === "PostToolUse" || name === "postToolUse") &&
      ["Read", "Edit", "Write", "MultiEdit", "apply_patch"].includes(event.tool_name)) {
    const ref = fileRef(event)
    context = ref ? touch + " File ref (data): " + JSON.stringify(ref) : touch
  }
  if (context) {
    const output = host === "cursor" ? { additional_context: context }
      : { hookSpecificOutput: { hookEventName: name, additionalContext: context } }
    process.stdout.write(JSON.stringify(output))
  }
} catch {
  // A malformed event is advisory. The session-context skill also teaches both lookups.
}
