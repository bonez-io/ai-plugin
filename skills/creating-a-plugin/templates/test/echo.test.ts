import { expect, test } from "bun:test"
import register from "../src/index"

// Tools are tested without Pi: a fake API records what the plugin registers, then we call execute().
function load() {
  const tools: Record<string, any> = {}
  register({ registerTool: (tool: { name: string }) => void (tools[tool.name] = tool) } as never)
  return tools
}

test("echo returns its input", async () => {
  const out = await load()["echo"].execute("call-1", { text: "hi" })
  expect(JSON.parse(out.content[0].text)).toEqual({ ok: true, text: "hi" })
})

test("echo reports an expected failure as a result, not a throw", async () => {
  const out = await load()["echo"].execute("call-2", { text: "x".repeat(10_001) })
  expect(JSON.parse(out.content[0].text)).toMatchObject({ ok: false, error: { code: "too_long" } })
})
