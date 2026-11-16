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
manifest.version = read("openai-submission/version").trim();
manifest.$schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
manifest.description = metadata.interface.longDescription;
manifest.extensions = { "com.openai": metadata };
fs.writeFileSync(path.join(output, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
fs.writeFileSync(path.join(output, "mcp.json"), JSON.stringify({
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  mcpServers: {
    bonez: {
      type: "streamable-http",
      url: "https://gateway.bonez.io/mcp?profile=directory",
      extensions: {
        "com.openai": {
          auth: {
            type: "oauth",
            client: { mode: "dcr" },
            baseScopes: ["bonez:read", "bonez:memory", "bonez:write"],
          },
        },
      },
    },
  },
}, null, 2) + "\n");

// Reuse the existing remote-only workflows; they already exclude local utilities.
fs.cpSync(path.join(root, "claude-directory/skills"), path.join(output, "skills"), { recursive: true });
// Public workflows use only the fixed directory tools and explicit memory consent.
fs.cpSync(path.join(root, "openai-submission/skills"), path.join(output, "skills"), { recursive: true });
fs.mkdirSync(path.join(output, "assets"));
fs.copyFileSync(path.join(root, "assets/bonez-icon-512.png"), path.join(output, "assets/icon.png"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
fs.writeFileSync(path.join(output, "README.md"), `# Bonez\n\n${metadata.interface.longDescription}\n\nSign in with your Bonez account when prompted. Your organization's administrator must connect and index the sources you want to use.\n\nThis package contains eleven skills and one remote MCP server. Local session capture, automatic recall hooks and local plugin-building utilities are distributed separately in the repository.\n\n- Website and source: ${metadata.interface.websiteURL}\n- Support: ${metadata.interface.supportURL}\n- Privacy: ${metadata.interface.privacyPolicyURL}\n- Terms: ${metadata.interface.termsOfServiceURL}\n`);
console.log(`Built ${manifest.name} ${manifest.version} at ${output}. Review preparation is separate from package construction.`);
