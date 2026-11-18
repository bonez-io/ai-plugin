#!/usr/bin/env node
// Generates cursor-directory/ (the variant submitted to the Cursor Marketplace) from claude-directory/
// (already hook-free) and the Cursor-specific rule, commands, manifest and mcp.json.
// Run: node scripts/build-cursor-directory.mjs   (regenerate claude-directory/ first if skills changed).
// Deterministic; CI regenerates it and fails on any diff. Cursor reviews every plugin and update by hand
// and expects markdown/skills only: no hooks, bin/ or scripts.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "cursor-directory");
const src = (p) => path.join(root, p);
const write = (p, s) => { fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true }); fs.writeFileSync(path.join(out, p), s); };

const manifest = JSON.parse(fs.readFileSync(src("cursor/.cursor-plugin/plugin.json"), "utf8"));
const mcp = JSON.parse(fs.readFileSync(src("cursor/mcp.json"), "utf8"));
const v = manifest.version;
const EXCLUDE_COMMANDS = ["bonez-new-plugin.md"];
const FORBIDDEN = [/\bhooks?\b/i, /\bgate\b/i, /bonez-plugin/, /CLAUDE_PLUGIN_ROOT/, /creating-a-plugin/, /new-plugin/,
  /bonez_url/, /BONEZ_/, /\bbin\//, /session-sync/];

fs.rmSync(out, { recursive: true, force: true });
write(".cursor-plugin/plugin.json", JSON.stringify({ ...manifest, logo: "assets/logo.svg" }, null, 2) + "\n");
mcp.mcpServers.bonez.headers["x-bonez-mcp-consumer"] = "cursor-directory-plugin";
write("mcp.json", JSON.stringify(mcp, null, 2) + "\n");

const problems = [];
const copy = (from, to) => {
  const text = fs.readFileSync(src(from), "utf8");
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${from} matches ${re}`);
  write(to, text);
};
for (const f of fs.readdirSync(src("claude-directory/skills"), { recursive: true }).sort()) {
  if (fs.statSync(src(`claude-directory/skills/${f}`)).isFile()) copy(`claude-directory/skills/${f}`, `skills/${f}`);
}
for (const c of fs.readdirSync(src("cursor/commands")).sort()) if (!EXCLUDE_COMMANDS.includes(c)) copy(`cursor/commands/${c}`, `commands/${c}`);
// The Cursor rule mentions no hooks; keep it as is.
copy("cursor/rules/bonez.mdc", "rules/bonez.mdc");
if (problems.length) throw new Error(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);

fs.mkdirSync(path.join(out, "assets"), { recursive: true });
fs.copyFileSync(src("cursor/assets/logo.svg"), path.join(out, "assets/logo.svg"));
fs.copyFileSync(src("LICENSE"), path.join(out, "LICENSE"));
write("README.md", `# Bonez for Cursor

The System Model is your organization's connected model of its code, tickets, people, services, agents and what they learned. Bonez keeps it, and this plugin connects Cursor to it over MCP.

## What it adds

- **Search**: one query across code, docs, tickets, PRs, conversations and people.
- **Impact analysis**: who calls a function, what breaks if you change or delete it, which tests cover it.
- **Rules**: your organization's standing rules, applied when the agent reviews or writes code.
- **Memories**: durable facts your team saved, such as conventions and decisions. Saving one is a write, so Cursor's own tool-approval prompt applies.
- Commands: \`/bonez-context\`, \`/bonez-search\`, \`/bonez-agents\`.

## Sign in

Reload the window, then open **Customize > MCPs > bonez > Authenticate** and use your Bonez account. The plugin stores no key and runs no local code. It only talks to the Bonez server at https://gateway.bonez.io/mcp, sending headers with the plugin name and version. It needs no variables or configuration.

## Try it

- "Search Bonez for how we handle webhook retries."
- "What breaks if I rename \`issueRefund\`?"
- "Which rules apply to this pull request? Review it against them."

## Links

- Bonez: https://bonez.io
- Documentation: https://bonez.io/plugin/
- Source: https://github.com/bonez-io/ai-plugin
- Privacy policy: https://bonez.io/privacy
- Support: https://bonez.io/support/ or support@bonez.io

Customers who run their own Bonez server install from their server's install page instead of this plugin.
`);
console.log(`cursor-directory/ generated for v${v}`);
