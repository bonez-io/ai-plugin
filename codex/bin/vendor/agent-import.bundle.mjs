// ../harness-core/src/scrub.ts
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
var paths = {
  claudeHome: join(HOME, ".claude"),
  codexHome: join(HOME, ".codex")
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
import { readFileSync } from "node:fs";
function isoMs(value) {
  if (typeof value !== "string")
    return;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
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
        const input = scrubber.scrubValue(b.input ?? {});
        msgs.push({
          role: "tool",
          tool: b.name ?? "",
          text: JSON.stringify(input).slice(0, 4000),
          toolCallId: b.id || undefined,
          toolInput: input
        });
      } else if (b.type === "tool_result") {
        const c = scrubber.scrubValue(b.content ?? "");
        msgs.push({
          role: "tool",
          tool: "result",
          text: (typeof c === "string" ? c : JSON.stringify(c)).slice(0, 4000),
          toolResultFor: b.tool_use_id || undefined,
          toolResult: c,
          toolError: b.is_error === true ? true : undefined
        });
      }
    }
  }
  return msgs;
}
function sessionIdFromPath(p) {
  const leaf = p.split(/[\\/]/).pop() ?? p;
  return leaf.replace(/\.jsonl$/, "") || p;
}
var DROPPED_TURNS = new Set(["auto_continuation", "system"]);
function speaker(fields) {
  const kind = fields.origin && typeof fields.origin === "object" ? fields.origin.kind : undefined;
  const turn = typeof fields.turnOrigin === "string" ? fields.turnOrigin : undefined;
  if (kind === "peer" || turn === "peer")
    return "session";
  if (kind === "task-notification" || turn === "task_notification")
    return "task";
  if (turn === "scheduled")
    return "schedule";
  if (turn === "host_synthetic")
    return "host";
  if (fields.isMeta === true)
    return;
  if (turn !== undefined && DROPPED_TURNS.has(turn))
    return;
  if (kind !== undefined && kind !== "human")
    return;
  return "user";
}
function personQueuedPrompt(ev) {
  const a = ev.type === "attachment" ? ev.attachment : undefined;
  if (!a || typeof a !== "object" || a.type !== "queued_command" || a.commandMode !== "prompt")
    return;
  return speaker(a) === "user" ? a.prompt : undefined;
}
var carriesToolResult = (content) => Array.isArray(content) && content.some((b) => b && typeof b === "object" && b.type === "tool_result");
var textOf = (content) => typeof content === "string" ? content.trim() : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join(`
`).trim() : "";
function deliveredLater(events, at, prompt) {
  const text = textOf(prompt);
  if (!text)
    return false;
  for (let i = at + 1;i < events.length; i++) {
    const ev = events[i];
    if (ev.type === "assistant" && textOf(ev.message?.content))
      return false;
    if (ev.type === "user" && ev.isCompactSummary !== true && !carriesToolResult(ev.message?.content) && speaker(ev) === "user" && textOf(ev.message?.content) === text)
      return true;
  }
  return false;
}
function parseClaudeFile(path, scrubber, repos, scope) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const events = [];
  for (const line of raw.split(`
`)) {
    const s = line.trim();
    if (!s)
      continue;
    try {
      const ev = JSON.parse(s);
      if (ev && typeof ev === "object")
        events.push(ev);
    } catch {}
  }
  const messages = [];
  let cwd;
  let title = "";
  let firstTs;
  let lastTs;
  for (const [at, ev] of events.entries()) {
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
    const queued = personQueuedPrompt(ev);
    let content;
    let role;
    let actor = "user";
    if (queued !== undefined) {
      if (deliveredLater(events, at, queued))
        continue;
      content = queued;
      role = "user";
    } else {
      if (ev.type !== "user" && ev.type !== "assistant")
        continue;
      if (ev.isCompactSummary === true)
        continue;
      const msg = ev.message;
      if (!msg || typeof msg !== "object")
        continue;
      content = msg.content;
      role = msg.role ?? ev.type;
      if (ev.type === "user") {
        actor = speaker(ev);
        if (actor === undefined && !carriesToolResult(content))
          continue;
      }
    }
    for (const m of claudeContentToMessages(content, scrubber)) {
      if (m.role === "_") {
        if (actor === undefined)
          continue;
        m.role = role;
        if (role === "user" && actor !== "user")
          m.actor = actor;
      }
      m.ts = ts;
      m.cwd = ev.cwd;
      m.gitBranch = ev.gitBranch;
      m.sourceId = ev.uuid || undefined;
      messages.push(m);
    }
  }
  if (!messages.length)
    return null;
  if (scope === "repo" && !repoFor(cwd, repos))
    return null;
  return {
    agent: "claude-code",
    sessionId: sessionIdFromPath(path),
    title,
    workspacePath: cwd,
    repo: repoFor(cwd, repos),
    createdAt: firstTs,
    updatedAt: lastTs,
    messages,
    sourcePath: path
  };
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
function codexToolInput(rawValue, scrubber) {
  if (typeof rawValue === "string") {
    try {
      const parsed = JSON.parse(rawValue);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return scrubber.scrubValue(parsed);
      }
    } catch {}
    return { raw: scrubber.scrubText(rawValue) };
  }
  if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
    return scrubber.scrubValue(rawValue);
  }
  return {};
}
var CODEX_EXIT_CODE_RE = /\b(?:Process exited with code|Exit code:?)\s+(\d+)/i;
function codexToolError(output) {
  const match = CODEX_EXIT_CODE_RE.exec(output);
  return match ? match[1] !== "0" : undefined;
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
    const payload = ev?.payload && typeof ev.payload === "object" ? ev.payload : undefined;
    const payloadType = payload?.type;
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const callId = String(payload.call_id ?? "") || undefined;
      const rawInput = payloadType === "function_call" ? payload.arguments : payload.input;
      const input = codexToolInput(rawInput, scrubber);
      messages.push({
        role: "tool",
        tool: String(payload.name ?? ""),
        text: JSON.stringify(input).slice(0, 4000),
        toolCallId: callId,
        toolInput: input,
        cwd,
        ts
      });
      continue;
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const callId = String(payload.call_id ?? "") || undefined;
      const rawOutput = payload.output;
      const output = scrubber.scrubText(typeof rawOutput === "string" ? rawOutput : JSON.stringify(rawOutput ?? ""));
      messages.push({
        role: "tool",
        tool: "result",
        text: output.slice(0, 4000),
        toolResultFor: callId,
        toolResult: output,
        toolError: codexToolError(output),
        cwd,
        ts
      });
      continue;
    }
    const node = payload?.role ? payload : ev;
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
    sessionId: sessionIdFromPath(path),
    workspacePath: cwd,
    repo: repoFor(cwd, repos),
    createdAt: firstTs,
    updatedAt: lastTs,
    messages,
    sourcePath: path
  };
}
export {
  walkFiles,
  repoFor,
  paths,
  parseCodexFile,
  parseClaudeFile,
  normalizeRepos,
  Scrubber,
  MASK,
  HOME
};
