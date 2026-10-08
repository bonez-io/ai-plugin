---
name: creating-a-plugin
description: Create, extend, test, bundle and hand over a Bonez plugin (a "package" that adds tools to Bonez agents). Use when the user wants to write a Bonez plugin, package, extension or new agent tool, add a tool to one, build or hash one, or asks how a plugin gets onto a Bonez box.
---

# Creating a Bonez plugin

A Bonez plugin is a TypeScript module whose default export calls `pi.registerTool(...)`. It adds **tools** to Bonez agents, nothing else. The long reference is `reference/SPEC.md` next to this file: read it before answering a question this page does not settle, and say "unverified" rather than guess.

**To create a new plugin, follow the steps of `/bonez-new-plugin`** (`<skill folder>/../../commands/bonez-new-plugin.md`; `<skill folder>` is the folder that holds this SKILL.md, whose path Cursor lists with the skill, and the tools and the command sit two folders above it): three questions, scaffold from `templates/`, write the tools, `bun install`, `bun test`, `bun run typecheck`, `bun run build:package`, hash, publish (or the manual handoff when publishing fails). Do the steps in order and stop at the first failure.

**To add a tool to an existing plugin:** one plain function per tool in `src/<tool>.ts`, a `registerTool` call in `src/index.ts`, a test in `test/`, then run the same four commands and hash again. Any change to the bundle changes the sha256, so publish or hand over the new folder and the new hash together.

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

- **Publish** (a server on a release with plugin upload): `node "<skill folder>/../../bin/bonez-plugin-push.mjs" --server <address> <abs path>/<name>/out/<name>` signs the user in to their Bonez server in the browser the first time and uploads the built folder with its sha256. `<address>` is the server (`https://bonez.example.com`; a trailing `/mcp` is dropped, a bare host gets `https://`, `http://` for localhost), or leave `--server` out when `BONEZ_URL` is set. The first run prints `sign in at: <address>` and `code: <code>` and exits 4 at once: tell the user to open the address and approve (a browser tab was also opened), then run the same command again to finish. The sign-in is saved (`~/.bonez/plugin-login.json`, mode 0600 on macOS and Linux) and reused; `--logout` forgets it. Only an org admin can publish. The server checks the hash again, vets the files, stores the version and makes it active; the tool prints the name, version, fingerprint and the number of computers it rolls out to, or the server's refusal code and detail as sent. **Never ask for, print, read or store an API key or a token.** For CI or a machine without a browser an org admin can mint a `plugins`-scope API key in the console and set `BONEZ_API_KEY` (with `BONEZ_URL`): the tool then uploads with the key and never signs in (set in the shell the tool is started from: `export` in bash, `$env:` in PowerShell, which reaches only programs started from that window). A publish does not carry env vars, apt packages or mounts: those stay a one-time edit by an operator. A server that predates plugin upload answers 404 or does not know the operation: use the folder install or send the source. `/bonez-new-plugin` step 7 runs it, and prints the manual text below only when publishing cannot finish.
- **Verify the publish:** the tool prints how many computers the plugin rolls out to, and the Library page of the Bonez console lists the plugin with each computer's state. With an API key set, `node "<skill folder>/../../bin/bonez-plugin-push.mjs" --status <package name>` lists the active version with its fingerprint (it must equal the publish's) and, per computer, `ready` once that computer holds it (`not_delivered` until its next heartbeat, about 30 seconds; `failed` comes with the reason); a signed-in session cannot list plugins yet. The plugin is then in the **Plugins** field of the agent builder.
- **Use it in an agent:** choose the plugin in the agent builder's **Plugins** field. That writes the agent's `metadata.packages`; at run time the server turns it into `execution.packages` of the run plan, and the harness mounts exactly the plugins the plan names (they win over the box-wide `BONEZ_PI_PACKAGES`). A run that names a plugin its machine does not hold fails before its first model call, saying which. An agent that must run on one of your computers also needs its **Runs on** tag.
- **Folder install** (a Bonez computer, or a server on a release with folder plugins): the folder from `bun run build:package` is copied to `/var/lib/bonez/packages/<package name with "/" as "__">/` on the machine that runs the agent, pinned by the sha256 from `bin/bonez-package-hash.mjs` in `BONEZ_PI_PACKAGES_SHA256`, named in `BONEZ_PI_PACKAGES`, and the runner is restarted (`sudo bonez-computer restart` on a computer). A wrong or missing sha256 makes the runner refuse the plugin and log the hash it saw. Do not invent options beyond the steps in the command.
- **Older servers** (no plugin upload, no folder plugins): the user sends Bonez the source folder, plus env var names, apt packages and directories to mount, and Bonez compiles the plugin in.
- `BONEZ_PI_PACKAGES` is the box-wide switch: every run on the box gets those plugins unless its plan names its own.

## Files

- `templates/` — the scaffold (`package.json`, `tsconfig.json`, `src/index.ts`, `test/echo.test.ts`, `scripts/build-package.mjs`, `scripts/tree-hash.mjs`, `.gitignore`). Placeholders: `__PACKAGE_NAME__`, `__DESCRIPTION__`. `bun run build:package` prints the folder's `sha256:`.
- `reference/SPEC.md` — the full reference. Bun 1.3.14, Pi 0.87.1.
- `<skill folder>/../../bin/bonez-package-hash.mjs <folder>` — prints the tree hash; refuses symlinks, `node_modules/` and the `.DS_Store`, `Thumbs.db` and `desktop.ini` files Finder and Explorer add (the server refuses them too: delete them).
- `<skill folder>/../../bin/bonez-plugin-push.mjs <folder>` — publishes the built folder to `$BONEZ_URL` (or `--server <url>`), signed in through the browser or with `$BONEZ_API_KEY`; exit 0 published, 1 refused by the server, 2 nothing sent (bad folder or config), 3 unreachable or unreadable answer, 4 waiting for the sign-in to be approved (it prints `sign in at:` and `code:`; run it again after). `--login` and `--logout` start and forget the sign-in; `--status [<package name>]` (API key only for now) lists what the server holds and each computer's state.
- If those two tools are not there (this skill was copied out of its plugin), use `bin/` of a clone of bonez-io/ai-plugin.
