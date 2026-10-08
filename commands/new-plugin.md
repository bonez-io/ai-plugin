---
name: new-plugin
description: Scaffold, test, bundle and hash a new Bonez plugin (a package that adds tools to Bonez agents), then push it to your Bonez server (or print the manual handoff)
argument-hint: <name>
---

# /bonez:new-plugin

Create a new Bonez plugin named **$ARGUMENTS** and get it onto your Bonez server. Read the `creating-a-plugin` skill first: its rules apply to every line of code you write here. `${CLAUDE_PLUGIN_ROOT}` is this plugin's install folder; if it was not expanded below, it is the folder that contains `skills/creating-a-plugin/`.

Run every command from an absolute path (`cd /abs/path && ...`): the shell's directory drifts between calls. On Windows these run in Git Bash (Git for Windows), where `pwd` prints `/c/Users/...` and every command below is the same; pass paths as `pwd` prints them. **If any step fails, stop, show the exact error output and say which step failed.** You may fix a mistake in the code you just wrote and rerun that step. Never skip a step, weaken or delete a test, loosen types to get green, or report a step as passed when it did not run.

## 1. Name and scope

- The name is the first word of `$ARGUMENTS`, lowercased. Drop a leading `pi-`. It must match `^[a-z][a-z0-9-]*$`; if it is empty or invalid, ask for one.
- The package name is `@<scope>/pi-<name>`. Scope defaults to the org in `git remote get-url origin` (for `git@github.com:acme/x.git`, `acme`), lowercased. With no remote, ask for the scope in your question message (step 2) and wait.
- Work in `./<name>/` under the current directory. If it exists and is not empty, stop and ask: never overwrite.
- Check `bun --version` and `node --version` (Node 18 or newer runs the hash and push tools). Bonez pins bun 1.3.14: if bun or node is missing, stop and tell the user to install it; if the bun version differs, say so and continue. On Windows give them these lines (PowerShell or cmd), one per missing tool, and tell them to **restart Claude Code itself** afterwards, not only the terminal: a running Claude Code keeps the PATH it started with, so a tool installed after that stays invisible to it until it is restarted:

  ```
  winget install --id Oven-sh.Bun --exact --version 1.3.14
  winget install --id OpenJS.NodeJS.LTS -e
  winget install --id Git.Git -e
  ```

## 2. Ask at most three questions, in one message

Skip any the user already answered. Do not ask follow-ups beyond these: if an answer is vague, propose a design in one line and go on.

1. **What should the plugin do?** One or two sentences.
2. **Which tools, with their arguments?** For each: a short name (it will be prefixed, so `build`, not `render_build`; the prefix is the package name without its scope and `pi-`, each run of characters other than letters and digits written `_`, so a tool `hello` in `@acme/pi-hello-check` reaches the model as `hello_check_hello`), what it does, its arguments with type and whether required. Offer to propose the list from answer 1.
3. **Which environment variables or secrets does it need, and which extra binaries?** Names only: never ask them to paste a value. Also any apt packages (the runner image has bun, Node 22, Python 3, uv, git, ripgrep, curl; no ffmpeg) and any host directory it must read.

## 3. Scaffold

1. `node -e "require('fs').cpSync(process.argv[1], process.argv[2], { recursive: true })" "${CLAUDE_PLUGIN_ROOT}/skills/creating-a-plugin/templates" "<abs path>/<name>"` (the same in every shell; it copies `.gitignore` too).
2. In `<name>/package.json` replace `__PACKAGE_NAME__` with the package name and `__DESCRIPTION__` with a one-sentence description from answer 1. The description sits inside a JSON string: **JSON-escape it** (`\"` for a double quote, `\\` for a backslash, no line breaks), or set the field with a JSON serializer (read the file with `JSON.parse`, assign `description`, write it back with `JSON.stringify(pkg, null, 2)`). A description pasted as plain text with a `"` in it breaks the file; check it still parses, from `<name>/`: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`.
3. Write the tools from answer 2:
   - one plain function per tool in `src/<tool>.ts` (no `pi` inside), and a `pi.registerTool` call per tool in `src/index.ts` using the template's `reply` and `fail` helpers;
   - the `echo` example tool and `test/echo.test.ts` are removed once your tools replace them;
   - JSON Schema with `additionalProperties: false`, a description the model can act on, `signal` passed to `spawn` and `fetch`;
   - every path argument through the allowed-root helper (uncomment it in `src/index.ts`, set `ALLOWED_ROOTS` to the directories from answer 3; its second parameter is the list of roots, so a test calls `allowedPath(file, [tempDir])` with a directory it made under `os.tmpdir()` and never relies on `/clips`);
   - env vars read with `process.env` inside the function, with a clear `fail("missing_config", ...)` when one is unset; never log their values;
   - a tool that needs its Bonez org reads `process.env.BONEZ_AGENT_ORG_ID` (the org's id, set by the runner on every run; it needs no forwarding and is unset under `bun test`, so the test sets it) and never asks the model for it;
   - long remote jobs as a `..._start` and `..._status` pair; your own timeout on every remote call;
   - one `test/<tool>.test.ts` per tool, in the template's fake-API style: a success, an expected failure and, for path tools, a path outside the allowed roots.
4. Do not add dependencies the tools do not need. Dependencies you do add are bundled by the build.

## 4. Install, test, typecheck, build

In `<abs path>/<name>/`, one command at a time, each must exit 0:

1. `bun install`
2. `bun test`
3. `bun run typecheck`
4. `bun run build:package`

Then check the output: `out/<name>/` must hold only `package.json` and `dist/index.js`, with no `node_modules/`. The build bundles every dependency; the Pi import is type-only, so nothing of Pi is bundled. The build ends by printing `sha256: <hash>`, the tree hash of `out/<name>/`: the value the push sends and the server checks.

## 5. Hash

`node "${CLAUDE_PLUGIN_ROOT}/bin/bonez-package-hash.mjs" "<abs path>/<name>/out/<name>"`

It prints the sha256 of the folder tree, and it must equal the `sha256:` line the build printed (stop and show both if it does not). If it exits non-zero (a symlink, `node_modules/`, or a `.DS_Store`, `Thumbs.db` or `desktop.ini` that Finder or Explorer added to the folder), stop and show the message.

## 6. Print the HANDOFF block

Derive every value from files and command output, not from memory (on Windows print the folder with `pwd -W`, so the operator gets a `C:\...` path): the package name from `out/<name>/package.json`, the sha256 from step 5, the tool names as `<prefix>_<tool>` from the package name and the registered tool names (the prefix: the package name without its scope and `pi-`, each run of characters other than letters and digits written `_`), the env var names from `grep -rnoE "(process|Bun)\.env(\.[A-Za-z_][A-Za-z_0-9]*|\[[^]]+\])" src || true` (grep exits 1 when nothing matches, and that is not a failure: no output means the code reads none; the template's own comments only say `process.env` bare, so they do not match) merged with answer 3 (say so if they differ). Print:

```
HANDOFF: <package name>
Folder:                <abs path>/<name>/out/<name>/   (package.json + dist/index.js only)
sha256:                <hash>
Tools the model sees:  <prefix>_<tool>, ...
Env vars to forward:   <NAMES>  (BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH; send names, never values)
Apt packages:          <packages, or none>  (RUNNER_EXTRA_APT_PACKAGES)
Directories to mount:  <paths, or none>
```

## 7. Push

Check whether a key and a server are set, without printing either: `node -e "console.log(process.env.BONEZ_API_KEY && process.env.BONEZ_URL ? 'push' : 'manual')"`. Never print, echo or ask for the value of `BONEZ_API_KEY`.

**If it prints `push`,** upload the folder:

`node "${CLAUDE_PLUGIN_ROOT}/bin/bonez-plugin-push.mjs" "<abs path>/<name>/out/<name>"`

It sends the folder with its sha256 to the server, which checks the hash again, vets the files, stores the version and makes it active. Show its output as it is: name, version, fingerprint (it must equal the sha256 of step 5) and how many computers it rolls out to; if it refuses, the refusal code and detail from the server. Exit 0 is success. On any other exit code **stop and show the exact output**; do not retry with other options and do not fall back to the manual text below unless the user asks. What each code means: 1 the server refused the plugin (fix what the detail says, rebuild, hash and push again); 2 nothing was sent (a folder or configuration problem, named in the message); 3 the server could not be reached or answered badly.

After a successful push, **verify it**: `node "${CLAUDE_PLUGIN_ROOT}/bin/bonez-plugin-push.mjs" --status "<package name>"`. It must show the active version with the same fingerprint as step 5, and each computer reads `ready` once it has the plugin: `not_delivered` until its next heartbeat (about 30 seconds), `failed` with a reason otherwise (stop and show it). Run it again after a minute if a computer is not `ready` yet; "no computers are enrolled" means nothing takes the plugin yet. Then say how it gets used: in the agent builder an admin chooses the plugin in the agent's **Plugins** field (it is listed there as soon as it is uploaded); that writes the agent's `metadata.packages`, the server copies it into the run plan's `execution.packages`, and the harness mounts exactly those plugins. An agent that must run on one of their computers also needs its **Runs on** tag. The next step is an agent that uses the plugin: offer to create one with the `creating-an-agent` skill (its `plugins` field takes the package name).

Then say what the push does **not** carry: the env vars to forward, the apt packages and the directories to mount from the HANDOFF block are still a one-time edit on each computer by an operator (secrets never travel in a push). If the block says none for all three, there is nothing more to do: the plugin reaches the computers on their next heartbeat once they run a runner that supports plugin sync.

**If it prints `manual`,** print the manual install text below and add one line: to push in one command next time, an org admin mints an API key with the **plugins** scope in the Bonez console, and the user sets `BONEZ_URL` (your server, e.g. `https://bonez.example.com`; the `/mcp` address works too) and `BONEZ_API_KEY` in the shell they start Claude Code from, then restarts it from that same window (`$env:` in PowerShell reaches only that window and the programs started from it; Claude Code started from the Start menu or another window does not see it). Show both forms (the second one is for Windows):

```bash
export BONEZ_URL=https://bonez.example.com
export BONEZ_API_KEY=bnz_...
```

```powershell
$env:BONEZ_URL = "https://bonez.example.com"
$env:BONEZ_API_KEY = "bnz_..."
```

```
FOLDER INSTALL (a Bonez computer, or a server on a release with folder plugins): an operator
  1. copies the folder out/<name>/ to /var/lib/bonez/packages/<package name with "/" replaced by "__">/ on the machine that runs the agent,
  2. adds <package name> to BONEZ_PI_PACKAGES and <package name>=<sha256> to BONEZ_PI_PACKAGES_SHA256 in the runner's env file,
  3. adds every env var above to BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH,
  4. restarts the runner (sudo bonez-computer restart on a computer).
A wrong or missing sha256 makes the runner refuse the plugin and log the hash it saw.

OLDER SERVERS: if the server predates folder plugins, send Bonez the source folder
<abs path>/<name>/ (not node_modules, not out/) with the env var names, apt packages and
directories above. Bonez compiles it in from the TypeScript source.
```

End with these notes, short:
- The sha256 covers every byte of `out/<name>/`. Rebuild and re-hash after any change, and push or send the folder and hash from the same build. Opening the folder in Finder or Explorer can add `.DS_Store`, `Thumbs.db` or `desktop.ini`: the server refuses an upload that holds one (it accepts only `package.json` and files under `dist/`), and the hash and push tools stop and name the file. Delete it, or rebuild.
- Anyone can verify what they received with `node "${CLAUDE_PLUGIN_ROOT}/bin/bonez-package-hash.mjs" <folder>`.
- A plugin is not sandboxed and skips the agent's tool allowlist; say which paths, programs and network calls this one uses so the reviewer can judge it.
- Pushing needs a server release with plugin upload; an older server answers 404 and the CLI says so.
