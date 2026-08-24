import { createRequire } from "node:module";
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../core/src/scrub.ts
var MASK = "****";
var HIGH_PRECISION = [
  ["private_key_block", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ["aws_access_key_id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["openai_key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["stripe_key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["bonez_api_key", /\bbnz_[0-9a-f]{32,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ["bearer_token", /\bbearer\s+[A-Za-z0-9._-]{16,}\b/gi],
  ["connection_string", /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:'"]+:[^\s@'"]+@[^\s'"]+/gi]
];
var ASSIGN = /\b(api[_-]?key|secret(?:[_-]?key)?|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|pwd|private[_-]?key|token)\b\s*[:=]\s*['"]?([^\s'"]{6,})['"]?/gi;
var EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
var PHONE = /(?<!\d)(?:\+?\d[\d .-]{7,}\d)(?!\d)/g;

class Scrubber {
  scrubPii;
  counts = {};
  constructor(scrubPii = false) {
    this.scrubPii = scrubPii;
  }
  hit(kind) {
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    return MASK;
  }
  scrubText(text) {
    if (!text)
      return text ?? "";
    let out = text;
    for (const [kind, pat] of HIGH_PRECISION)
      out = out.replace(pat, () => this.hit(kind));
    out = out.replace(ASSIGN, (whole, _key, value) => whole.replace(value, () => this.hit("assigned_secret")));
    if (this.scrubPii) {
      out = out.replace(EMAIL, () => this.hit("email"));
      out = out.replace(PHONE, () => this.hit("phone"));
    }
    return out;
  }
  scrubValue(value) {
    if (typeof value === "string")
      return this.scrubText(value);
    if (Array.isArray(value))
      return value.map((v) => this.scrubValue(v));
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.scrubValue(v)]));
    return value;
  }
  report() {
    const total = Object.values(this.counts).reduce((a, b) => a + b, 0);
    return { total, byType: { ...this.counts } };
  }
}
// src/sources.ts
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
var HOME = homedir();
function cursorAppSupport() {
  if (process.platform === "darwin")
    return join(HOME, "Library", "Application Support", "Cursor");
  if (process.platform === "win32")
    return join(process.env.APPDATA ?? HOME, "Cursor");
  return join(HOME, ".config", "Cursor");
}
var paths = {
  claudeHome: join(HOME, ".claude"),
  claudeJson: join(HOME, ".claude.json"),
  codexHome: join(HOME, ".codex"),
  cursorState: () => join(cursorAppSupport(), "User", "globalStorage", "state.vscdb"),
  cursorUserSettings: () => join(cursorAppSupport(), "User", "settings.json"),
  cursorMcp: join(HOME, ".cursor", "mcp.json")
};
function walkFiles(dir, match, maxDepth = 8) {
  const out = [];
  const visit = (d, depth) => {
    if (depth > maxDepth)
      return;
    let names;
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(d, name);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir)
        visit(p, depth + 1);
      else if (!match || match(p))
        out.push(p);
    }
  };
  if (existsSync(dir))
    visit(dir, 0);
  return out;
}
function listFiles(dir, suffix) {
  if (!existsSync(dir))
    return [];
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix)).map((name) => join(dir, name)).filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
function normalizeRepos(repos) {
  return (repos ?? []).map((r) => resolve(r.startsWith("~") ? join(HOME, r.slice(1)) : r));
}
function repoFor(p, repos) {
  if (!p)
    return;
  let c;
  try {
    c = resolve(p);
  } catch {
    return;
  }
  return repos.find((r) => c === r || c.startsWith(r + sep));
}
// src/collectors.ts
import { existsSync as existsSync2, readFileSync, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join2 } from "node:path";
var MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
var tick = () => new Promise((r) => setImmediate(r));
function asText(v) {
  if (typeof v === "string")
    return v;
  if (v instanceof Uint8Array)
    return Buffer.from(v).toString("utf8");
  return String(v ?? "");
}
function isoMs(value) {
  if (typeof value !== "string")
    return;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}
async function collectCursor(scrubber, repos, scope) {
  const dbPath = paths.cursorState();
  if (!existsSync2(dbPath))
    return [];
  let db;
  try {
    const { DatabaseSync: DatabaseSyncCtor } = await import("node:sqlite");
    db = new DatabaseSyncCtor(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  const out = [];
  try {
    const headers = [];
    const headerRow = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'").get();
    if (headerRow?.value) {
      try {
        const data = JSON.parse(asText(headerRow.value));
        headers.push(...Array.isArray(data) ? data : data.allComposers ?? []);
      } catch {}
    }
    const seen = new Set(headers.map((h) => h.composerId));
    for (const kv of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
      const cid = kv.key.replace("composerData:", "");
      if (seen.has(cid))
        continue;
      try {
        const conv = JSON.parse(asText(kv.value));
        headers.push({
          composerId: cid,
          name: conv.name ?? "",
          createdAt: conv.createdAt ?? 0,
          lastUpdatedAt: conv.lastUpdatedAt ?? 0,
          workspaceIdentifier: conv.workspaceIdentifier
        });
      } catch {}
    }
    const dataStmt = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    let processed = 0;
    for (const h of headers) {
      if (++processed % 20 === 0)
        await tick();
      const cid = h.composerId;
      if (!cid)
        continue;
      const ws = h.workspaceIdentifier?.uri?.fsPath;
      const repo = repoFor(ws, repos);
      if (scope === "repo" && !repo)
        continue;
      const dataRow = dataStmt.get(`composerData:${cid}`);
      if (!dataRow?.value)
        continue;
      let conv;
      try {
        conv = JSON.parse(asText(dataRow.value));
      } catch {
        continue;
      }
      const messages = [];
      for (const mh of conv.fullConversationHeadersOnly ?? []) {
        const bid = mh.bubbleId;
        if (!bid)
          continue;
        const br = dataStmt.get(`bubbleId:${cid}:${bid}`);
        if (!br?.value)
          continue;
        let bubble;
        try {
          bubble = JSON.parse(asText(br.value));
        } catch {
          continue;
        }
        const text = scrubber.scrubText(bubble.text || bubble.richText || "");
        if (!text)
          continue;
        messages.push({ role: bubble.type === 1 ? "user" : "assistant", text });
      }
      if (!messages.length)
        continue;
      out.push({
        agent: "cursor",
        sessionId: cid,
        title: scrubber.scrubText(h.name || ""),
        workspacePath: ws,
        repo,
        createdAt: h.createdAt || undefined,
        updatedAt: h.lastUpdatedAt || undefined,
        messages,
        sourcePath: dbPath
      });
    }
  } finally {
    db.close();
  }
  return out;
}
function claudeContentToMessages(content, scrubber) {
  const msgs = [];
  if (typeof content === "string") {
    const t = scrubber.scrubText(content);
    if (t.trim())
      msgs.push({ role: "_", text: t });
    return msgs;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== "object")
        continue;
      const b = block;
      if (b.type === "text") {
        const t = scrubber.scrubText(b.text ?? "");
        if (t.trim())
          msgs.push({ role: "_", text: t });
      } else if (b.type === "tool_use") {
        msgs.push({ role: "tool", tool: b.name ?? "", text: JSON.stringify(scrubber.scrubValue(b.input ?? {})).slice(0, 4000) });
      } else if (b.type === "tool_result") {
        const c = scrubber.scrubValue(b.content ?? "");
        msgs.push({ role: "tool", tool: "result", text: (typeof c === "string" ? c : JSON.stringify(c)).slice(0, 4000) });
      }
    }
  }
  return msgs;
}
function parseClaudeFile(path, scrubber, repos, scope) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const messages = [];
  let cwd;
  let title = "";
  let firstTs;
  let lastTs;
  for (const line of raw.split(`
`)) {
    const s = line.trim();
    if (!s)
      continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object")
      continue;
    cwd = cwd ?? ev.cwd;
    const ts = isoMs(ev.timestamp);
    if (ts) {
      firstTs = firstTs ?? ts;
      lastTs = ts;
    }
    if (ev.type === "summary" && !title) {
      title = scrubber.scrubText(ev.summary ?? "").slice(0, 120);
      continue;
    }
    const msg = ev.message;
    if (!msg || typeof msg !== "object")
      continue;
    const role = msg.role ?? (ev.type === "assistant" ? "assistant" : "user");
    for (const m of claudeContentToMessages(msg.content, scrubber)) {
      if (m.role === "_")
        m.role = role;
      m.ts = ts;
      messages.push(m);
    }
  }
  if (!messages.length)
    return null;
  if (scope === "repo" && !repoFor(cwd, repos))
    return null;
  return {
    agent: "claude-code",
    sessionId: path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path,
    title,
    workspacePath: cwd,
    repo: repoFor(cwd, repos),
    createdAt: firstTs,
    updatedAt: lastTs,
    messages,
    sourcePath: path
  };
}
async function collectClaude(scrubber, repos, scope) {
  const projects = join2(paths.claudeHome, "projects");
  if (!existsSync2(projects))
    return [];
  const out = [];
  for (const dir of readdirSync2(projects)) {
    for (const f of listFiles(join2(projects, dir), ".jsonl")) {
      await tick();
      const conv = parseClaudeFile(f, scrubber, repos, scope);
      if (conv)
        out.push(conv);
    }
  }
  return out;
}
var CODEX_ROLES = new Set(["user", "assistant", "system", "tool"]);
function findCwd(obj) {
  if (!obj || typeof obj !== "object")
    return;
  for (const k of ["cwd", "cwd_path", "working_directory", "workdir"]) {
    if (typeof obj[k] === "string" && obj[k])
      return obj[k];
  }
  for (const v of Object.values(obj)) {
    const f = findCwd(v);
    if (f)
      return f;
  }
  return;
}
function codexText(content, scrubber) {
  if (typeof content === "string")
    return scrubber.scrubText(content);
  const parts = [];
  if (Array.isArray(content)) {
    for (const b of content) {
      if (typeof b === "string")
        parts.push(b);
      else if (b && typeof b === "object")
        parts.push(b.text ?? b.content ?? "");
    }
  } else if (content && typeof content === "object") {
    parts.push(content.text ?? "");
  }
  return scrubber.scrubText(parts.filter(Boolean).join(`
`));
}
function parseCodexFile(path, scrubber, repos, scope) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const messages = [];
  let cwd;
  let firstTs;
  let lastTs;
  for (const line of raw.split(`
`)) {
    const s = line.trim();
    if (!s)
      continue;
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    cwd = cwd ?? findCwd(ev);
    const ts = isoMs(ev?.timestamp);
    if (ts) {
      firstTs = firstTs ?? ts;
      lastTs = ts;
    }
    const node = ev?.payload?.role ? ev.payload : ev;
    if (!node || !CODEX_ROLES.has(node.role))
      continue;
    const text = codexText(node.content ?? node.text ?? "", scrubber);
    if (!text.trim())
      continue;
    messages.push({ role: node.role, text, ts });
  }
  if (!messages.length)
    return null;
  if (scope === "repo" && !repoFor(cwd, repos))
    return null;
  return {
    agent: "codex",
    sessionId: path.split("/").pop()?.replace(/\.jsonl$/, "") ?? path,
    workspacePath: cwd,
    repo: repoFor(cwd, repos),
    createdAt: firstTs,
    updatedAt: lastTs,
    messages,
    sourcePath: path
  };
}
async function collectCodex(scrubber, repos, scope) {
  const sessions = join2(paths.codexHome, "sessions");
  const out = [];
  for (const f of walkFiles(sessions, (p) => p.endsWith(".jsonl"))) {
    await tick();
    const conv = parseCodexFile(f, scrubber, repos, scope);
    if (conv)
      out.push(conv);
  }
  return out;
}
function globalFileSpecs() {
  const c = paths.claudeHome;
  const x = paths.codexHome;
  return [
    { agent: "claude-code", kind: "memory", label: "Global CLAUDE.md", files: [join2(c, "CLAUDE.md")] },
    {
      agent: "claude-code",
      kind: "memory",
      label: "Auto-memory store",
      files: walkFiles(join2(c, "projects"), (p) => p.includes("/memory/") && p.endsWith(".md"))
    },
    { agent: "claude-code", kind: "config", label: "User settings", files: [join2(c, "settings.json")], sensitive: true, fmt: "json" },
    { agent: "claude-code", kind: "prompt", label: "Slash commands", files: listFiles(join2(c, "commands"), ".md") },
    { agent: "claude-code", kind: "prompt", label: "Subagents", files: listFiles(join2(c, "agents"), ".md") },
    { agent: "claude-code", kind: "config", label: "Top-level config + MCP", files: [paths.claudeJson], sensitive: true, fmt: "json" },
    { agent: "cursor", kind: "config", label: "User settings", files: [paths.cursorUserSettings()], sensitive: true, fmt: "json" },
    { agent: "cursor", kind: "config", label: "Global MCP", files: [paths.cursorMcp], sensitive: true, fmt: "json" },
    { agent: "codex", kind: "rule", label: "Global AGENTS.md", files: [join2(x, "AGENTS.md")] },
    { agent: "codex", kind: "config", label: "Config + MCP", files: [join2(x, "config.toml")], sensitive: true, fmt: "toml" },
    { agent: "codex", kind: "prompt", label: "Saved prompts", files: listFiles(join2(x, "prompts"), ".md") }
  ];
}
function repoFileSpecs(repo) {
  return [
    { agent: "claude-code", kind: "rule", label: "CLAUDE.md", files: walkFiles(repo, (p) => p.endsWith("/CLAUDE.md"), 4) },
    { agent: "claude-code", kind: "config", label: "Project settings", files: [join2(repo, ".claude", "settings.json")], sensitive: true, fmt: "json" },
    { agent: "claude-code", kind: "config", label: "Project MCP", files: [join2(repo, ".mcp.json")], sensitive: true, fmt: "json" },
    { agent: "cursor", kind: "rule", label: "Legacy .cursorrules", files: [join2(repo, ".cursorrules")] },
    { agent: "cursor", kind: "rule", label: "Project rules (MDC)", files: walkFiles(join2(repo, ".cursor", "rules"), (p) => p.endsWith(".mdc")) },
    { agent: "codex", kind: "rule", label: "AGENTS.md", files: walkFiles(repo, (p) => p.endsWith("/AGENTS.md"), 4) }
  ];
}
async function collectArtifacts(scrubber, scope, repos, enabled) {
  const specs = scope === "repo" ? repos.flatMap((r) => repoFileSpecs(r)) : globalFileSpecs();
  const out = [];
  for (const spec of specs) {
    if (!enabled.has(spec.agent))
      continue;
    for (const file of spec.files) {
      if (!existsSync2(file))
        continue;
      await tick();
      let raw;
      try {
        if (statSync2(file).size > MAX_ARTIFACT_BYTES)
          continue;
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let content;
      if (spec.sensitive && spec.fmt === "json") {
        try {
          content = JSON.stringify(scrubber.scrubValue(JSON.parse(raw)), null, 2);
        } catch {
          content = scrubber.scrubText(raw);
        }
      } else {
        content = scrubber.scrubText(raw);
      }
      out.push({
        agent: spec.agent,
        scope,
        kind: spec.kind,
        label: spec.label,
        sourcePath: file,
        content,
        fmt: spec.fmt ?? "text",
        repo: scope === "repo" ? repoFor(file, repos) : undefined
      });
    }
  }
  return out;
}
export {
  walkFiles,
  tick,
  repoFor,
  paths,
  parseCodexFile,
  parseClaudeFile,
  normalizeRepos,
  listFiles,
  collectCursor,
  collectCodex,
  collectClaude,
  collectArtifacts,
  Scrubber,
  MASK,
  HOME
};
