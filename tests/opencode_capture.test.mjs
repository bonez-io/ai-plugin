import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { gunzipSync } from "node:zlib"
import { startStubGateway } from "./lib/stub-gateway.mjs"

test("completed OpenCode turns respect capture scope, redact before upload and skip duplicate events", async t => {
  const dir = mkdtempSync(join(tmpdir(), "bonez-oc-"))
  const gateway = await startStubGateway()
  t.after(async () => { await gateway.close(); rmSync(dir, { recursive: true, force: true }) })
  process.env.BONEZ_SESSION_SYNC_DATA = dir
  process.env.BONEZ_GATEWAY_URL = gateway.url
  delete process.env.CLAUDE_PLUGIN_OPTION_BONEZ_URL
  const { captureOpenCode } = await import("../bin/bonez-session-sync.mjs")
  const config = { enabled: true, gateway: gateway.url, apiKey: "test", scope: "repo", repos: [dir] }
  const configure = enabled => writeFileSync(join(dir, "config.json"), JSON.stringify({ ...config, enabled }))
  const session = { id: "ses_example", location: { directory: dir } }
  const forbidden = () => assert.fail("should not read transcript")
  configure(false)
  await captureOpenCode(session, forbidden)
  configure(true)
  await captureOpenCode({ ...session, parentID: "parent" }, forbidden)
  await captureOpenCode({ ...session, fork: { sessionID: "original" } }, forbidden)
  await captureOpenCode({ ...session, location: { directory: tmpdir() } }, forbidden)
  await captureOpenCode(session, () => [{ type: "user", text: "outside the repo" }, { type: "location-switched" }])
  const messages = [
    { type: "system", text: "system-only" },
    { type: "user", text: "password=not-for-upload" },
    { type: "assistant", content: [{ type: "reasoning", text: "reasoning-only" },
      { type: "tool", text: "tool-only" }, { type: "text", text: "first reply" }] },
  ]
  await captureOpenCode(session, () => messages)
  await captureOpenCode(session, () => messages)
  messages.push({ type: "user", text: "second prompt" })
  await captureOpenCode(session, () => messages)
  assert.equal(gateway.calls.complete.length, 2)
  assert.deepEqual(gateway.calls.presign[0].body, { agent: "opencode", scope: "repo" })
  const raw = gunzipSync(gateway.calls.put[1].body).toString()
  assert.doesNotMatch(raw, /not-for-upload|system-only|reasoning-only|tool-only/)
  const [, conversation] = raw.trim().split("\n").map(JSON.parse)
  assert.equal(conversation.sessionId, session.id)
  assert.deepEqual(conversation.messages.map(m => m.text), ["password=****", "first reply", "second prompt"])
})
