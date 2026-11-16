#!/usr/bin/env node
// Build a separate public upload. Never edit the local Codex or Claude packages.
// Usage: node scripts/build-openai-plugin.mjs /absolute/output/bonez
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || path.basename(output) !== "bonez") {
  throw new Error("Supply an absolute, new output directory named bonez.");
}
// Fail on an existing target rather than deleting anyone's package or saved metadata.
fs.mkdirSync(output, { recursive: false });
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const source = JSON.parse(read("codex/.codex-plugin/plugin.json"));
const metadata = JSON.parse(read("openai-submission/metadata.json"));
const manifest = Object.fromEntries(
  ["name", "version", "description", "author", "homepage", "repository", "license", "keywords"]
    .map((key) => [key, source[key]]).filter(([, value]) => value !== undefined),
);
manifest.$schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
manifest.description = metadata.interface.longDescription;
manifest.extensions = { "com.openai": metadata };
fs.writeFileSync(path.join(output, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(output, "mcp.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    bonez: {
      type: "streamable-http",
      url: "https://gateway.bonez.io/mcp",
      headers: {
        "x-bonez-mcp-consumer": "openai-directory-plugin",
        "x-bonez-plugin-version": source.version,
      },
      extensions: {
        "com.openai": {
          auth: {
            type: "oauth",
            baseScopes: ["bonez:read", "bonez:memory", "bonez:write"],
          },
        },
      },
    },
  },
}, null, 2) + "\n");

// Reuse the existing remote-only workflows; they already exclude local utilities.
fs.cpSync(path.join(root, "claude-directory/skills"), path.join(output, "skills"), { recursive: true });
const remembering = path.join(output, "skills/remembering/SKILL.md");
let text = fs.readFileSync(remembering, "utf8");
const from = "The app's own tool-permission prompt asks before a write, so expect it to ask — that is working as intended, not an error.";
if (!text.includes(from)) throw new Error("remembering approval wording drifted; inspect before packaging");
text = text.replace(from, "Explain the proposed write and obtain the user's authorization before saving. Honor any host tool-permission prompt; this public package does not install a per-tool approval policy.");
const automaticSave = "Saving is a PRIMARY action, not end-of-task cleanup. The moment you learn something durable, save it right then, while you can still phrase it well. Under-saving is the common failure: a fact you don't store is a mistake the whole org repeats.";
if (!text.includes(automaticSave)) throw new Error("remembering save wording drifted; inspect before packaging");
text = text.replace(automaticSave,
  "When you learn something durable, offer a concise note for the user to approve. Save only when the user requests or authorizes it, while the relevant evidence is still available.");
// Align the portable skill with the current MCP schema and verify saved state.
text = text.replace('`close` (and `note`, see below)', '`close`, `propose`');
text = text.replaceAll('"kind": "convention"', '"kind": "fact"');
text = text.replace('`preference`, `convention`, `decision`, `gotcha`, `procedure`, `context`, `claim` or `note`', '`rule`, `skill`, `procedure`, `gotcha`, `decision`, `fact`, `preference` or `note`');
text = text.replace('required for `kind: "context"` (a temporary status)', 'required for a temporary status');
text = text.replace('(`convention`, `decision`, `procedure`, `gotcha`)', '(`fact`, `decision`, `procedure`, `gotcha`)');
text = text.replace('(`kind: context`)', '(`kind: note`)');
text = text.replace('- `note` and `scope: "session"`. They are session scratch, which needs a verified interactive session; this connection has none, so `scope: "session"` is refused and a `note` without a scope is stored as a personal memory, not as disposable scratch. Use `remember`.', '- `scope: "session"` requires a verified interactive session, which this connection does not provide. Use `op: "remember"` with an explicitly authorized personal or organization scope. `note` is a memory kind, not an operation.');
text = text.replace('## After you save: new memories start `pending`', '## After you save: verify the result\n\nAfter every successful write, fetch the returned memory ID with `system_model_fetch` before reporting completion. Check the saved content, scope and state. If readback fails, say that the write succeeded but verification is incomplete; do not retry the write.\n\n### New memories start `pending`');
fs.writeFileSync(remembering, text);
fs.mkdirSync(path.join(output, "assets"));
fs.copyFileSync(path.join(root, "assets/bonez-icon-512.png"), path.join(output, "assets/icon.png"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
fs.writeFileSync(path.join(output, "README.md"), `# Bonez\n\n${metadata.interface.longDescription}\n\nSign in with your Bonez account when prompted. Your organization's administrator must connect and index the sources you want to use.\n\nThis package contains eleven skills and one remote MCP server. Local session capture, automatic recall hooks and local plugin-building utilities are distributed separately in the repository.\n\n- Website and source: ${metadata.interface.websiteURL}\n- Support: ${metadata.interface.supportURL}\n- Privacy: ${metadata.interface.privacyPolicyURL}\n- Terms: ${metadata.interface.termsOfServiceURL}\n`);
console.log(`Built ${manifest.name} ${manifest.version} at ${output}. Review preparation is separate from package construction.`);
