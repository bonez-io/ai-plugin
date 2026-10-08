// File-system helpers for tests that must also pass on Windows.
import { symlinkSync } from "node:fs"

// Create a symlink, or skip the calling test. On Windows creating a symlink needs a privilege
// (Developer Mode or an elevated shell) and fails with EPERM without it; the skip says so instead of
// failing a test that is about something else. `type` is "junction" for a directory junction, which
// needs no privilege. Returns true when the link exists.
export function symlinkOrSkip(t, target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES") {
      t.skip(`cannot create a symlink here (${err.code}); enable Developer Mode or run elevated`)
      return false
    }
    throw err
  }
}

// Same, for a test that has more to assert than the link: returns false when the link cannot be made
// (the caller then leaves the link-dependent assertions out) and throws on any other error.
export function trySymlink(target, path, type) {
  try {
    symlinkSync(target, path, type)
    return true
  } catch (err) {
    if (err.code === "EPERM" || err.code === "EACCES") return false
    throw err
  }
}
