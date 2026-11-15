#!/usr/bin/env node
// Generates claude-directory/ (the variant submitted to Anthropic's plugin directory) from the
// root plugin. Run from anywhere: node scripts/build-directory-plugin.mjs
// The root plugin (hooks, bin/, userConfig URL) is never touched. The output is deterministic;
// CI regenerates it and fails on any diff.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "claude-directory");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const write = (p, s) => {
  fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true });
  fs.writeFileSync(path.join(out, p), s);
};

// Skills and commands that need what this variant lacks (bin/ tools, code templates, a server URL choice).
const EXCLUDE_SKILLS = ["creating-a-plugin"];
const EXCLUDE_COMMANDS = ["new-plugin.md", "connect.md"];

// [file, source text, replacement]. Every source text must still exist: drift fails the build, and the
// error lists EVERY stale entry at once. When a skill's prose changes, update its source text here to the
// new wording and keep the replacement saying the same thing for an app that has no hooks or bin/ tools.
const REWRITES = [
  ["skills/remembering/SKILL.md",
    "The plugin gates the tool behind a permission prompt on every call, including `preflight` and `dry_run`, so expect the harness to ask — that is the gate working, not an error.",
    "The app's own tool-permission prompt asks before a write, so expect it to ask — that is working as intended, not an error."],
  ["skills/reviewing-with-org-rules/SKILL.md",
    "Writes need an API key with the `read+write` scope (a lesser key gets",
    "Writes need a sign-in with the `read+write` scope (a lesser one gets"],
  ["skills/creating-an-agent/SKILL.md",
    "Nothing in this plugin gates `vendor_write` on any harness (the write gate covers `memory_save` and `rules_write` only), so your own question is the guard.",
    "Do not count on the app's tool-permission prompt for `vendor_write`: your own question is the guard."],
  ["skills/session-context/SKILL.md",
    "use the records the hook already supplied. Otherwise batch up to",
    "batch up to"],
  ["skills/using-the-tool-lake/SKILL.md",
    "Nothing in this plugin stops a vendor write, on any harness.",
    "Nothing in this plugin stops a vendor write; the app's tool-permission prompt may not cover it."],
  ["skills/using-the-tool-lake/SKILL.md",
    "so run `bonez-plugin-push`, which calls it (an org admin only).",
    "so leave it to org admins using Bonez's own tools."],
];

// After rewriting, none of these may remain: each describes behaviour only the root plugin has.
const FORBIDDEN = [/\bhooks?\b/i, /\bgate\b/i, /bonez-plugin/, /CLAUDE_PLUGIN_ROOT/, /creating-a-plugin/, /new-plugin/,
  /bonez_url/, /BONEZ_/, /\bbin\//, /session-sync/];

const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
const v = manifest.version;
if (!v) throw new Error("root plugin.json has no version");

fs.rmSync(out, { recursive: true, force: true });

// plugin.json: same identity, no userConfig, plus directory listing fields.
const { userConfig, ...rest } = manifest;
write(".claude-plugin/plugin.json", JSON.stringify({
  ...rest,
  documentationUrl: "https://github.com/bonez-io/ai-plugin#readme",
  icon: "./assets/icon.png",
}, null, 2) + "\n");

write(".mcp.json", JSON.stringify({
  mcpServers: {
    bonez: {
      type: "http",
      url: "https://gateway.bonez.io/mcp",
      headers: { "x-bonez-mcp-consumer": "claude-directory-plugin", "x-bonez-plugin-version": v },
    },
  },
}, null, 2) + "\n");

const applied = new Set();
const problems = [];
function copyText(rel) {
  let text = read(rel);
  REWRITES.forEach(([f, from, to], i) => {
    if (f !== rel) return;
    if (!text.includes(from)) { problems.push(`rewrite #${i} no longer matches in ${f}: ${JSON.stringify(from)}`); return; }
    text = text.replace(from, () => to);
    applied.add(i);
  });
  for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${rel} still matches ${re} — add a rewrite or exclude it`);
  write(rel, text);
}

for (const s of fs.readdirSync(path.join(root, "skills")).sort()) {
  if (EXCLUDE_SKILLS.includes(s)) continue;
  for (const f of fs.readdirSync(path.join(root, "skills", s), { recursive: true }).sort()) {
    if (fs.statSync(path.join(root, "skills", s, f)).isFile()) copyText(`skills/${s}/${f}`);
  }
}
for (const c of fs.readdirSync(path.join(root, "commands")).sort()) {
  if (!EXCLUDE_COMMANDS.includes(c)) copyText(`commands/${c}`);
}
REWRITES.forEach((r, i) => { if (!applied.has(i) && !problems.some((p) => p.startsWith(`rewrite #${i} `))) problems.push(`rewrite #${i} targets a file that was not copied: ${r[0]}`); });
if (problems.length) throw new Error(`${problems.length} problem(s), nothing is final:\n  ${problems.join("\n  ")}`);

write("README.md", `# Bonez

The System Model is your organization's connected model of its code, tickets, people, services, agents and what they learned. Bonez keeps it, and this plugin connects Claude to it.

## What it adds

- **Search**: one query across code, docs, tickets, PRs, conversations and people.
- **Impact analysis**: who calls a function, what breaks if you change or delete it, which tests cover it.
- **Rules**: your organization's standing rules, applied when Claude reviews or writes code.
- **Memories**: durable facts your team saved, such as conventions and decisions, available to every session. Saving one is a write, so the app's own permission prompt applies.

## Sign in

The first time Claude uses Bonez it opens a sign-in page: use your Bonez account. The plugin stores no key and runs no local code. It only talks to the Bonez server at https://gateway.bonez.io/mcp, sending a header with the plugin name and version.

## Try it

- "Search Bonez for how we handle webhook retries."
- "What breaks if I rename \`issueRefund\`?"
- "Which rules apply to this pull request? Review it against them."

## Links

- Bonez: https://bonez.io
- Source and full documentation: https://github.com/bonez-io/ai-plugin
- Privacy policy: https://bonez.io/privacy
- Support: support@bonez.io

Customers who run their own Bonez server install from their server's install page instead of this plugin.
`);

write("LICENSE", read("LICENSE"));
fs.mkdirSync(path.join(out, "assets"), { recursive: true });
fs.copyFileSync(path.join(root, "assets/bonez-icon-512.png"), path.join(out, "assets/icon.png"));
console.log(`claude-directory/ generated for v${v}`);
