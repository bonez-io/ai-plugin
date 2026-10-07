---
name: creating-a-plugin
description: Create, extend, test, bundle and hand over a Bonez plugin (a "package" that adds tools to Bonez agents). Use when the user wants to write a Bonez plugin, package, extension or new agent tool, add a tool to one, build or hash one, or asks how a plugin gets onto a Bonez box.
---

# Creating a Bonez plugin

A Bonez plugin is a TypeScript module whose default export calls `pi.registerTool(...)`. It adds **tools** to Bonez agents, nothing else. The long reference is `reference/SPEC.md` next to this file: read it before answering a question this page does not settle, and say "unverified" rather than guess.

**To create a new plugin, follow the steps of `/bonez:new-plugin`** (`${CLAUDE_PLUGIN_ROOT}/commands/new-plugin.md`): three questions, scaffold from `templates/`, write the tools, `bun install`, `bun test`, `bun run typecheck`, `bun run build:package`, hash, handoff. Do the steps in order and stop at the first failure.

**To add a tool to an existing plugin:** one plain function per tool in `src/<tool>.ts`, a `registerTool` call in `src/index.ts`, a test in `test/`, then run the same four commands and hash again. Any change to the bundle changes the sha256, so hand over the new folder and the new hash together.

## Facts that decide the design

- **The only API is `pi.registerTool` (and `pi.registerCommand`, which nothing runs: plan on tools only).** `pi.on`, hooks, skills, prompts and themes do not work. Do not design around them.
- **Tool names get a prefix.** Package `@acme/pi-render`, tool `build`: the model sees `render_build`. The prefix is the package name without its scope and leading `pi-`. Register the short name.
- **Not sandboxed.** The plugin runs in the harness process as the container's user, with the whole filesystem, the network and `process.env` (which holds the run's gateway token). It also skips the agent's tool allowlist. The facade is not a security boundary.
- **Config is environment variables only,** read inside the function. Each name must be forwarded (`BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH`), or the code never sees it. There is no secret store.
- **The runner container has no ffmpeg and no GPU.** Extra binaries are apt packages the box adds. GPU work goes to a remote HTTP service: `..._start` and `..._status` tools, not one blocking call.
- **No per-call timeout and no result size limit.** Set your own timeout on remote calls and return paths, not bytes.
- **Errors:** a call fails only if `execute` throws, and the run view then shows just "Tool call failed". Return expected failures as `{ ok: false, error: { code, message } }`; throw only for bugs.

## Rules for every tool you write

1. **Never write to stdout.** No `console.log`, no `process.stdout.write`: the run-event stream lives there and one stray line fails the run. Use `console.error`, briefly.
2. **Never log secrets:** keys, tokens, `BONEZ_GATEWAY_TOKEN`, URLs that carry a key, `process.env` as a whole, file bytes.
3. **Paths:** restrict every path argument to an allowed root (the template has a commented `allowedPath` helper). The model writes the argument and text it read can steer it.
4. **Processes:** `spawn(bin, [args])`, never a shell string and never `exec` with interpolation.
5. **Validate** ranges and values even though Pi checks the JSON Schema. Schemas set `additionalProperties: false`.
6. **Pass `signal`** to `spawn` and `fetch`. Make a repeated call safe (runs can be retried); set `executionMode: "sequential"` if two calls must not overlap.
7. **Import Pi with `import type` only.** The build bundles every other import into `dist/index.js` and ships no `node_modules`.
8. **Env var names, never values,** go in code, tests, the handoff and chat. Never ask the user to paste a secret.

## Installing: be exact about status

- **Today:** the plugin is compiled into Bonez. The user sends Bonez the folder (source today, plus env var names, apt packages and directories to mount).
- **Planned, in build, not released** (Bonez branch `shay/1si-2286-folder-packages`): the folder from `bun run build:package` is copied to the box and verified against the sha256 from `bin/bonez-package-hash.mjs`. Never say it works today, never promise a date, and do not invent options beyond the steps in the command.
- `BONEZ_PI_PACKAGES` is the one switch. An agent spec's `metadata.packages` does not reach the harness.

## Files

- `templates/` — the scaffold (`package.json`, `tsconfig.json`, `src/index.ts`, `test/echo.test.ts`, `scripts/build-package.mjs`, `.gitignore`). Placeholders: `__PACKAGE_NAME__`, `__DESCRIPTION__`.
- `reference/SPEC.md` — the full reference. Bun 1.3.14, Pi 0.87.1.
- `${CLAUDE_PLUGIN_ROOT}/bin/bonez-package-hash.mjs <folder>` — prints the tree hash; refuses symlinks and `node_modules/`.
