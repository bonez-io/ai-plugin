import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// Rules for every tool you add (details: the creating-a-plugin skill, reference/SPEC.md):
//  - NEVER write to stdout (console.log): the runner reads stdout as the event stream and the run fails.
//    Use console.error, briefly, and never log secrets, tokens, URLs that carry a key, or process.env.
//  - Treat every argument as untrusted: check ranges, restrict paths to allowed roots (see below).
//  - Call programs with spawn(bin, [args]), never a shell string. Pass `signal` to spawn and fetch.
//  - Config comes from process.env, read inside the function; each name must also be forwarded
//    (BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH), or your code never sees it.
//  - Return expected failures as a result (see fail); throw only for bugs.
//  - Import Pi with `import type` only: the build bundles everything else and ships no node_modules.

// One result shape for every tool: the model reads `content`; `details` (an object) is stored with the session.
const reply = (result: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  details: result,
})
const fail = (code: string, message: string) => reply({ ok: false, error: { code, message } })

// Path allow-roots. Uncomment, set ALLOWED_ROOTS, and call allowedPath() on every path argument
// before touching the file. Follows symlinks. For a file you will create, check its parent directory.
//
// import { realpathSync } from "node:fs"
// import { isAbsolute, relative, resolve, sep } from "node:path"
//
// const ALLOWED_ROOTS = ["/clips"] // container paths; a new host directory needs a volume line from Bonez
//
// function allowedPath(input: string): string | null {
//   try {
//     const real = realpathSync(resolve(input))
//     for (const root of ALLOWED_ROOTS) {
//       const rel = relative(realpathSync(root), real)
//       if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return real
//     }
//   } catch {}
//   return null // missing path, unmounted root, or outside every root
// }
// // in a tool: const p = allowedPath(params.path); if (!p) return fail("path_not_allowed", "path is outside the allowed roots")

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "echo", // the model sees <prefix>_echo; the prefix is the package name without its scope and leading "pi-"
    label: "Echo",
    description: "Return the given text unchanged. Call it to check that the plugin is loaded.",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "Any text, up to 10000 characters." } },
      required: ["text"],
      additionalProperties: false,
    } as never,
    async execute(_id, params: { text: string }) {
      if (params.text.length > 10_000) return fail("too_long", "text is longer than 10000 characters")
      return reply({ ok: true, text: params.text })
    },
  })
}
