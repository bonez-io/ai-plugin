// The files a Codex `apply_patch` call adds or changes. Codex's PostToolUse hook gives the patch
// as `tool_input.command` (developers.openai.com/codex/hooks, "PostToolUse"), not a file path, and
// names each file on a `*** Add File: <path>` or `*** Update File: <path>` line. A deleted file is
// left out. Paths are as written in the patch, usually relative to the session's cwd.
export function applyPatchFiles(toolInput) {
  const patch = typeof toolInput === "string" ? toolInput : toolInput?.command
  if (typeof patch !== "string") return []
  const seen = new Map()
  for (const m of patch.matchAll(/^\*\*\* (Add|Update) File: (.+?)[ \t]*\r?$/gm)) {
    if (!seen.has(m[2])) seen.set(m[2], m[1] === "Add" ? "write" : "edit")
  }
  return [...seen].map(([path, tool]) => ({ path, tool }))
}
