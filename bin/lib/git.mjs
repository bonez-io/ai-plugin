// Local Git lookups shared by the recall hook and session capture. Synchronous, short timeouts,
// stderr dropped: a missing Git or a scratch directory throws and the caller treats it as "no repo".
import { execFileSync } from "node:child_process"

export const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 600, maxBuffer: 8192,
}).trim()

// `owner/name` (or `group/sub/name`) from the origin remote of the repository holding `dir`.
export function originRepo(dir) {
  const origin = git(dir, "config", "--get", "remote.origin.url").replace(/\/$/, "").replace(/\.git$/, "")
  // https://host[:port]/o/n, ssh://git@host[:port]/o/n, or scp-style git@host:o/n. Credentials in the URL do not match.
  return /^(?:(?:https:\/\/|ssh:\/\/git@)[a-zA-Z0-9.-]+(?::\d+)?\/|git@[a-zA-Z0-9.-]+:)([\w.-]+(?:\/[\w.-]+)+)$/.exec(origin)?.[1]
}
