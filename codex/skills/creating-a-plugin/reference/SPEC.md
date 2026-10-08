# Writing a Bonez plugin: reference

Facts about what a Bonez plugin is, what it can do and where it runs. Written 2026-10-07 from Bonez's code (bonez-core `main`, commit `f121fc39`); sections 1, 2, 4, 8, 9 and 10 rechecked against `main` at commit `af9df20b1` on 2026-10-08. Read it when the `creating-a-plugin` skill or `/bonez:new-plugin` sends you here, or when a question about plugin behaviour comes up.

**Badges.** **Works today**: read in the code, it does this. **Planned**: being built, may change, do not depend on it. `(unverified)`: could not be confirmed from the code. Never present a Planned item as released.

**Words.** *Pi*: the open-source agent library under Bonez's agent loop (pinned at 0.87.1). *Plugin*: Bonez's code calls it a "package": a TypeScript module that adds tools to the agent. *Run*: one execution of an agent. *Runner*: the container that executes runs. *Harness*: the Bonez program the runner starts for each run; it runs the agent loop and your plugin. *Tool*: a function the model can call, with a name, a description and a JSON Schema for its arguments.

**Five things to know**
1. You write and test a plugin, build it into a small folder (`package.json` and `dist/index.js`) and push it to your Bonez server (section 8). Plugins compiled into Bonez itself are a separate, built-in set.
2. A plugin can add tools. Nothing else.
3. A plugin is not sandboxed (section 6).
4. It runs in the runner container: that container's files and CPU, no GPU (section 5).
5. Configuration is environment variables, and each name must be on a list or your code never sees it (section 4).

---

## 1. What a plugin is and what it can do

**Works today**

A plugin is a TypeScript module. Its default export is a function:

```ts
export default function (pi: ExtensionAPI): void | Promise<void>
```

Bonez calls it when a run's agent session starts, passing a restricted copy of Pi's extension API (a "facade"). Two members work:

| Member | Effect |
|---|---|
| `pi.registerTool(definition)` | Adds a tool the model can call. |
| `pi.registerCommand(name, options)` | Allowed, namespaced like tools. Nothing in Bonez was found that runs a plugin command `(unverified)`. Plan on tools only. |

Any other member throws when touched: `package <name> may not use ExtensionAPI.<member>: packages can register tools and commands only`. That includes hooks such as `pi.on`. A package's skills, prompts and themes are not loaded.

**Names.** Every tool gets a prefix: the package name without its scope and a leading `pi-`, with each run of characters other than letters and digits turned into one `_`. `@acme/pi-render` gets `render`; `@acme/pi-hello-check` gets `hello_check`. Register `build` and the model sees `render_build`; with the second package, `hello` is seen as `hello_check_hello`. Register `render_build` and it becomes `render_render_build`.

**Which plugins load.** A run loads the plugins its plan names (`execution.packages`, which the server writes from the agent's `metadata.packages`: section 8), and only those. A plan that names none falls back to `BONEZ_PI_PACKAGES`, a comma-separated list of package names read when the run's session starts: every run on the box then gets every listed plugin. A name in the plan that the harness cannot mount (not compiled in, and not a folder pinned on that machine) fails the run before its first model call and the message names it. A name on the env list that cannot be mounted is skipped, with a warning in the log.

---

## 2. Package layout and manifest

**Works today**

```
my-plugin/
  package.json   tsconfig.json
  src/index.ts               default export; registers the tools
  src/<tool>.ts              one plain function per tool
  test/<tool>.test.ts
```

| `package.json` field | Used today? |
|---|---|
| `name` | Yes. A lowercase npm-style name (`@scope/pi-name`; the upload refuses anything else and `@bonez/*`). It is the plugin's identity everywhere: the pin, the agent's `metadata.packages`, the folder name. Sets the tool prefix. |
| `exports["."]` | Yes. Bonez runs `import("<name>")`. In the source package it points at the TypeScript source, which Bun runs directly. In the folder you hand over (`bun run build:package`) it points at `./dist/index.js`, and the upload needs that entry (or `pi.extensions[0]`) to be a `.js`, `.mjs` or `.cjs` file under `dist/`. |
| `peerDependencies` | Declare Pi at the exact pinned version (0.87.1). |
| `version` | Required by the upload: a string of 1 to 64 characters, shown in the plugin list. The loader does not read it (section 9). |
| `pi.extensions`, `keywords: ["pi-package"]` | Not read by Bonez's loader. Keep them in the source package: they make it a valid Pi package. |
| `scripts.test`, `scripts.typecheck` | For you and CI: `bun test`, `tsgo --noEmit`. |

Keep each tool's logic in a plain function that does not touch `pi`. Tests then do not need Pi.

---

## 3. Writing a tool

**Works today**

The pattern:

```ts
pi.registerTool({
  name: "gates",                       // the model sees <prefix>_gates
  label: "Video gates",                // short human name
  description: "What it does and when to call it. The model reads this.",
  parameters: {                        // plain JSON Schema, cast as shown
    type: "object",
    properties: { path: { type: "string", description: "Absolute path of the file." } },
    required: ["path"],
    additionalProperties: false,
  } as never,
  async execute(_id, params: { path: string }, signal) {
    const result = await gates(params.path, signal)
    return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
  },
})
```

- **Arguments.** Pi checks them against your schema before your code runs. A mismatch gets Pi's own generic "Validation failed" reply. Still check values yourself (paths, ranges).
- **`signal`** is an abort signal for the call. Pass it to `spawn` and `fetch`.
- **Result.** `content` is what the model reads: text blocks, and optionally images `{ type: "image", data: <base64>, mimeType }`. `details` is stored with the session. Make it an object: an array is not kept in the stored metadata (the `content` text still is), and a top-level string field `output` or object `bonez` is treated specially. Return the result as a JSON text block.

**Errors.** Pi marks a call failed only when `execute` throws. The message goes into the session transcript, and Pi passes it to the model (Pi's code was not available to check this `(unverified)`). The run view (the run-event stream) shows only "Tool call failed", with no reason. A tool that returns normally is a success, whatever its text says. Recommended: return expected failures as a result, throw only for bugs.

```ts
const fail = (code: string, message: string) => {
  const result = { ok: false as const, error: { code, message } }
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }
}
```

The model reads the reason, the transcript keeps it, and your agent instructions can say what to do per `code`. The cost: the run view shows the call as completed.

**Idempotency.** Pi runs the tool calls of one model message in parallel by default. Add `executionMode: "sequential"` to the definition if two calls must not overlap (the facade passes it through). A run can be retried (the child gets `BONEZ_AGENT_RUN_ATTEMPT`), so make a repeat safe. A paid model call is not cached: each call is a new charge.

**Timeouts and sizes**

| Limit | Value |
|---|---|
| Per tool call | No timeout. A call runs until it returns, throws or the run stops. Set your own on remote calls. |
| Per run | `limits.timeout_seconds`: 1 to 86,400. Also `max_steps` up to 1,000, `max_events` up to 5,000, `max_log_bytes` up to 5,000,000. |
| Tool result size | None enforced for plugin tools. All of it enters the model's context and the transcript. Return paths, not bytes. |
| Final structured result | 900,000 bytes (separate from tool results). |

---

## 4. Config and secrets

**Works today**

- **Environment variables only.** There is no other channel. Read `process.env` inside your functions.
- **Which org the run is for.** The runner puts `BONEZ_AGENT_ORG_ID` (the org's id, not its name) into the harness's environment on every run, next to `BONEZ_GATEWAY_URL` and `BONEZ_GATEWAY_TOKEN`. It is one of Bonez's own variables, so it needs no entry on the pass-through list. A tool reads `process.env.BONEZ_AGENT_ORG_ID`; it does not need the org as an argument. It is unset when you run `bun test`: set it in the test.
- **The child environment is hermetic.** The runner starts the harness with an explicit environment: `PATH`, `LANG`, `TZ`, a per-run `HOME`, Bonez's own `BONEZ_*` variables, and the names listed in `BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH` (comma-separated). A variable in the container but not on that list never reaches your code. The list can add variables; it cannot override one Bonez sets. It must include `BONEZ_PI_PACKAGES` itself (the proof setup used `BONEZ_PI_PACKAGES,GEMINI_API_KEY,BONEZ_PRINT_LOGS,BONEZ_LOG_LEVEL`). Proxy and private-CA variables (`HTTPS_PROXY`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) are dropped unless listed.
- **Getting a variable into the container.** On the Docker Compose box shape, the runner service forwards only the names its block lists (today `BONEZ_PI_PACKAGES`, `BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH`, `GEMINI_API_KEY`, `BONEZ_PRINT_LOGS`, `BONEZ_LOG_LEVEL`). A new variable needs a line there. Bonez adds it with the release.
- **Where a secret goes today.** In the box's env file (mode 600; Bonez's deploy tool refuses one that is group- or world-readable), forwarded as above. A plugin has no secret store to read. The runner's own comment says production credentials belong in organization secrets, but the facade gives a plugin no way to reach them.
- **Never log:** keys and tokens; `BONEZ_GATEWAY_TOKEN` (the run's token for Bonez's API on the box); any URL that carries a key (for example a `?key=` query parameter); `process.env` as a whole; file bytes.
- **Never write to stdout.** The harness writes the run-event stream to stdout, one JSON line per event. The runner rejects any other line (`malformed_json`) and the run fails. Whether the harness redirects `console.log` was not checked `(unverified)`. Use `console.error`, briefly: only the first 8 KiB of stderr is relayed, and Bonez redacts only its own tokens from it, not yours.

---

## 5. Where code runs

**Works today**

- **In the harness process, inside the runner container.** The agent's own shell and file tools run in a helper process (the "substrate"), which on the reference box is a second process in the same container. Package tools are not in that helper. Both run as user `bun`.
- **Paths are the container's paths.** On the reference box, clips are mounted read-only at `/clips`, from the host directory named by `VIDEO_REVIEW_CLIPS` in the box's env file. Any other host directory needs a volume line in the runner's compose block (Bonez adds it).
- **Binaries.** The image has bun, Node 22 with npm, Python 3 with venv and pip, uv, git, ripgrep and curl. **No ffmpeg.** Add apt packages with the build argument `EXTRA_APT_PACKAGES` (env-file variable `RUNNER_EXTRA_APT_PACKAGES`, for example `ffmpeg`). The box builds this image itself, so it applies on the next build. No `ssh` client was seen in the apt list `(unverified)`.
- **No GPU.** Nothing in the runner's image or compose block asks for one. Work that needs the GPU runs elsewhere.
- **Calling a remote machine.** Use `fetch` to a small HTTP service on the GPU or build machine: start a job, poll its status, fetch the result. For a long job, make two tools (`..._start`, `..._status`) instead of one call that blocks. Whether the runner container can reach your network is for your network team to confirm `(unverified)`.
- **Files you write** stay in the container (for example `/tmp`) and nothing collects them. Return what the agent needs in the tool result.

---

## 6. Trust and permissions

**Works today** (this is how it is, not a feature)

**A plugin is not sandboxed.** Its code runs in the harness process with the container's whole filesystem as user `bun`, any network the container has, and `process.env`, which holds the run's gateway token and every variable you passed through. The facade is a JavaScript `Proxy` that hides methods. It stops mistakes; it is not a security boundary, and Bonez's design notes say so. Plugin tools also **skip the agent's tool allowlist and permission rules** that guard Bonez's built-in tools: a test shows a run whose allowlist is only `read` still gets the plugin's tools. The only switch is `BONEZ_PI_PACKAGES`.

**On a single-tenant box running your own code** this is acceptable, at the same trust as Bonez's own code. The real risks are your bugs and the model's arguments:
- Treat every argument as untrusted. The model writes it, and text it read (a merge request, a file name) can steer it.
- Restrict paths to an allowed root such as `/clips`. Bonez does not do it for you.
- Call programs with `spawn(bin, [args])`, never a shell string.
- Give tokens only the rights the plugin needs.

---

## 7. Testing locally

**Works today**

- Use bun 1.3.14 (the version Bonez pins). If your tools call `ffmpeg` or other binaries, they must be on `PATH` where you run the tests.
- In the package folder: `bun test` and `bun run typecheck`.
- **Test tools without Pi.** Fake the API: an object whose `registerTool` records the definition. Call `definition.execute("call-1", {...})` and check the result. The template's `test/echo.test.ts` is a complete example.
- **Not covered locally:** the namespacing and the facade (Bonez tests those) and the full agent loop (it runs on a Bonez test cluster).
- A plugin that judges or scores something can be tested without an agent: call its functions directly against inputs whose right answer you know (one good, several deliberately broken).

---

## 8. Handing a plugin to Bonez

**Needs a server release with plugin upload (bonez-core `main` has it): push it.** `bin/bonez-plugin-push.mjs <folder>` (Node built-ins only) sends `out/<name>/` to `$BONEZ_URL/api/admin/org/plugins` as `{files: {<path>: <base64>}, sha256}` with `Authorization: Bearer $BONEZ_API_KEY`. `$BONEZ_URL` is your server's address; a trailing `/mcp` is dropped and a bare host gets `https://` (`http://` for localhost). The key needs the `plugins` scope: an org admin mints it in the console, it reaches only plugin upload and list, and the server refuses it as soon as its owner stops being an admin. The server recomputes the tree hash and vets the folder: a valid npm-style name, a `version` of 1 to 64 characters, an entry file under `dist/` (`exports["."]`, else `pi.extensions[0]`), no `node_modules`, no built-in or `@bonez/*` name, at most 32 files and 8 MiB, paths of letters, digits and `. _ - /` only, and only `package.json` and files under `dist/` ending in `.js .mjs .cjs .json .map .txt .md` (a `.DS_Store`, `Thumbs.db`, `README.md` or `src/` file in the folder gets the upload refused, and the hash and push tools refuse such a folder before sending). A refusal is printed with its code and detail as sent. The new version becomes the active one. Computers whose runner supports plugin sync fetch it on their next heartbeat, verify the hash again and swap it in when idle, so there is no restart and no env-file edit for the pins. Env vars to forward, apt packages and mounts are not part of the upload. Exit codes: 0 uploaded, 1 refused by the server, 2 nothing sent (bad folder or configuration), 3 unreachable or unreadable answer. An older server answers 404; use the folder install below.

**Verify it.** `bin/bonez-plugin-push.mjs --status [<package name>]` asks `GET /api/org/plugins` and prints each plugin's active version and fingerprint (the fingerprint must equal the push's) and, per computer, its state: `ready` once it holds and has pinned that version, `not_delivered` until its next heartbeat, `syncing` or `pending` while it is on its way, `failed` with the reason. The plugin is also listed on the Library page of the console, and an admin can upload, activate an earlier version or retire it there.

**Use it in an agent.** In the agent builder, choose the plugin in the **Plugins** field. That writes the agent's `metadata.packages`. When a run is planned, the server copies the list into the plan's `execution.packages` (the one rule, `execution_from_metadata` in `bonez_wire`); the harness mounts exactly those and they win over `BONEZ_PI_PACKAGES`. If a plugin is named that the run's machine does not hold, the run fails before its first model call. An agent that must run on one of your computers also sets **Runs on** (`metadata.runs_on`, a computer tag).

**Works on a Bonez computer and on servers on a release with folder plugins.** An operator copies the folder to `/var/lib/bonez/packages/<folder name>/` on the machine that runs the agent (the folder name is the package name with `/` replaced by `__`), adds `<name>=<sha256>` to `BONEZ_PI_PACKAGES_SHA256`, adds the name to `BONEZ_PI_PACKAGES`, forwards every env var the plugin reads through `BONEZ_RUNNER_CHILD_ENV_PASSTHROUGH`, and restarts the runner. The loader verifies the tree hash, then applies the same restricted facade; a wrong or missing pin refuses the plugin and the log prints the hash it saw. An agent can then name the plugin in its spec. The folder to hand over is the output of `bun run build:package` (`out/<name>/`: `package.json` and `dist/index.js`), together with its sha256 from `bonez-package-hash.mjs` (the build prints the same value). The check runs before the code is loaded, so keep the folder writable only by the operator. Still planned: enabling a package in the organization config as `packages.<name> = { enabled, sha256, env }`. Bonez's design notes also call for isolating unreviewed code in a separate process, so section 6 may change.

**Older servers (no plugin upload, no folder plugins).** Send Bonez the plugin folder. Bonez compiles the plugin into its own build from the TypeScript source, so send the source folder (without `node_modules/` and `out/`), after `bun test` and `bun run typecheck` pass. Also send the environment variable names it reads (names only, never values), any apt packages and any host directory it needs mounted. Bonez then rebuilds the runner image on the box.

---

## 9. Versioning and compatibility

**Works today** (minimal)

- `version` in `package.json` is the only version a plugin has. Use semver. The upload requires it (a string of 1 to 64 characters) and the plugin list shows it; the server keeps up to five versions of a name and one is active. Nothing else reads it: the loader looks a plugin up by name and its pinned hash.
- Compatibility means Pi. Bonez pins Pi at exactly 0.87.1 and a plugin declares the same. A pushed plugin is not rebuilt: it runs as you built it, so a Pi upgrade can break it when a run loads it. (A plugin compiled into Bonez is rebuilt with each release.) Write against 0.87.1.

---

## 10. Limits and caveats

**Works today** (this describes what is true now)

- **Two ways to choose plugins.** An agent spec's `metadata.packages` (the builder's **Plugins** field) reaches the harness as the run plan's `execution.packages` (the plan carries nothing else of `metadata`), and when the plan names plugins only those load. `BONEZ_PI_PACKAGES` is the box-wide fallback for a plan that names none.
- **No path restrictions from Bonez.** A plugin tool that accepts a path can read any path in the container (section 6). Add an allowed-root check to every plugin.
