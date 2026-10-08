---
name: creating-a-plugin
description: Create, extend, test, bundle and hand over a Bonez plugin (a "package" that adds tools to Bonez agents). Use when the user wants to write a Bonez plugin, package, extension or new agent tool, add a tool to one, build or hash one, or asks how a plugin gets onto a Bonez box.
---

# Creating a Bonez plugin

A Bonez plugin is a TypeScript module whose default export calls `pi.registerTool(...)`. It adds **tools** to Bonez agents, nothing else. The long reference is `reference/SPEC.md` next to this file: read it before answering a question this page does not settle, and say "unverified" rather than guess.

**To create a new plugin, follow the steps of `/prompts:new-plugin`** (`<skill folder>/../../prompts/new-plugin.md`; `<skill folder>` is the folder that holds this SKILL.md, the one to resolve relative paths against, and the tools and the prompt sit two folders above it; copy the prompt to `~/.codex/prompts/` to get the slash command): three questions, scaffold from `templates/`, write the tools, `bun install`, `bun test`, `bun run typecheck`, `bun run build:package`, hash, push (or the manual handoff). Do the steps in order and stop at the first failure.

**To add a tool to an existing plugin:** one plain function per tool in `src/<tool>.ts`, a `registerTool` call in `src/index.ts`, a test in `test/`, then run the same four commands and hash again. Any change to the bundle changes the sha256, so push or hand over the new folder and the new hash together.

## Facts that decide the design

- **The only API is `pi.registerTool` (and `pi.registerCommand`, which nothing runs: plan on tools only).** `pi.on`, hooks, skills, prompts and themes do not work. Do not design around them.
- **Tool names get a prefix.** Package `@acme/pi-render`, tool `build`: the model sees `render_build`. The prefix is the package name without its scope and leading `pi-`, with each run of characters other than letters and digits written `_`: `@acme/pi-hello-check` with a tool `hello` is seen as `hello_check_hello`. Register the short name.
- **Not sandboxed.** The plugin runs in the harness process as the container's user, with the whole filesystem, the network and `process.env` (which holds the run's gateway token). It also skips the agent's tool allowlist. The facade is not a security boundary.
- **Config is environment variables only,** read inside the function. Each name must be forwarded (`BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH`), or the code never sees it. There is no secret store.
- **Which Bonez org the tool runs for:** the runner sets `BONEZ_AGENT_ORG_ID` (the org's id, not its name) on every run, and it needs no forwarding, so a tool reads `process.env.BONEZ_AGENT_ORG_ID` and never takes the org as an argument. It is unset under `bun test`: set it in the test.
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
9. **Tests run on the developer's machine, which may be Windows** (the tool itself runs on the Linux runner). Build paths with `node:path` and `os.tmpdir()`, never `/tmp` or a hard-coded `/`; start programs with `spawn(bin, [args])` so no shell quoting is involved.

## Installing: be exact about status

- **Push** (a server on a release with plugin upload): `node "<skill folder>/../../bin/bonez-plugin-push.mjs" <abs path>/<name>/out/<name>` uploads the built folder with its sha256 to `$BONEZ_URL`, using the `plugins`-scope API key in `$BONEZ_API_KEY` (an org admin mints it in the console; it works only while its owner is an admin and reaches nothing but plugin upload and list). `$BONEZ_URL` is the server's address (`https://bonez.example.com`); a trailing `/mcp` is dropped, and a bare host gets `https://` (`http://` for localhost). The server checks the hash again, vets the files, stores the version and makes it active; the CLI prints the name, version, fingerprint and the number of computers it rolls out to, or the server's refusal code and detail as sent. Never print or ask for the key. The user sets both variables in the shell they start Claude Code (or Cursor, or Codex) from (`export BONEZ_URL=...` in bash, `$env:BONEZ_URL = "..."` in PowerShell: it reaches only programs started from that window). A push does not carry env vars, apt packages or mounts: those stay a one-time edit by an operator. An older server answers 404: use the folder install or send the source. `/prompts:new-plugin` step 7 runs the push when both variables are set and prints the manual text below when they are not.
- **Verify the push** with `node "<skill folder>/../../bin/bonez-plugin-push.mjs" --status <package name>`: it lists the active version with its fingerprint (it must equal the push's) and, per computer, `ready` once that computer holds it (`not_delivered` until its next heartbeat, about 30 seconds; `failed` comes with the reason). The plugin then appears in the Library page of the Bonez console and in the **Plugins** field of the agent builder.
- **Use it in an agent:** choose the plugin in the agent builder's **Plugins** field. That writes the agent's `metadata.packages`; at run time the server turns it into `execution.packages` of the run plan, and the harness mounts exactly the plugins the plan names (they win over the box-wide `BONEZ_PI_PACKAGES`). A run that names a plugin its machine does not hold fails before its first model call, saying which. An agent that must run on one of your computers also needs its **Runs on** tag.
- **Folder install** (a Bonez computer, or a server on a release with folder plugins): the folder from `bun run build:package` is copied to `/var/lib/bonez/packages/<package name with "/" as "__">/` on the machine that runs the agent, pinned by the sha256 from `bin/bonez-package-hash.mjs` in `BONEZ_PI_PACKAGES_SHA256`, named in `BONEZ_PI_PACKAGES`, and the runner is restarted (`sudo bonez-computer restart` on a computer). A wrong or missing sha256 makes the runner refuse the plugin and log the hash it saw. Do not invent options beyond the steps in the command.
- **Older servers** (no plugin upload, no folder plugins): the user sends Bonez the source folder, plus env var names, apt packages and directories to mount, and Bonez compiles the plugin in.
- `BONEZ_PI_PACKAGES` is the box-wide switch: every run on the box gets those plugins unless its plan names its own.

## Files

- `templates/` — the scaffold (`package.json`, `tsconfig.json`, `src/index.ts`, `test/echo.test.ts`, `scripts/build-package.mjs`, `scripts/tree-hash.mjs`, `.gitignore`). Placeholders: `__PACKAGE_NAME__`, `__DESCRIPTION__`. `bun run build:package` prints the folder's `sha256:`.
- `reference/SPEC.md` — the full reference. Bun 1.3.14, Pi 0.87.1.
- `<skill folder>/../../bin/bonez-package-hash.mjs <folder>` — prints the tree hash; refuses symlinks, `node_modules/` and the `.DS_Store`, `Thumbs.db` and `desktop.ini` files Finder and Explorer add (the server refuses them too: delete them).
- `<skill folder>/../../bin/bonez-plugin-push.mjs <folder>` — uploads the built folder to `$BONEZ_URL` with `$BONEZ_API_KEY`; exit 0 uploaded, 1 refused by the server, 2 nothing sent (bad folder or config), 3 unreachable or unreadable answer. `--status [<package name>]` lists what the server holds and each computer's state.
- If those two tools are not there (this skill was copied out of its plugin), use `bin/` of a clone of bonez-io/ai-plugin.
