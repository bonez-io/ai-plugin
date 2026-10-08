// A minimal MCP client for one tool call over streamable HTTP: initialize, notifications/initialized, tools/call.
// The gateway answers plain JSON; a server that streams answers as server-sent events is read too.
// Node built-ins only (Node 18+).
import { clean, fail, redirected, send } from "./net.mjs"

const PROTOCOL = "2025-06-18"

// The server answered with an HTTP error (401: the token; 403: scope or role). Not a tool result.
export class HttpRefusal extends Error {
  constructor(status, challenge, text) {
    super(`HTTP ${status}`)
    this.status = status
    this.challenge = challenge // the WWW-Authenticate header, "" if none
    this.text = text
  }
}

// The JSON-RPC message with `id` out of a JSON body or an event stream.
function message(res, text, id) {
  const stream = /text\/event-stream/i.test(res.headers.get("content-type") ?? "")
  const candidates = stream
    ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n"))
    : [text]
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.id === id) return parsed
    } catch {
      // not JSON: an event that carries no message, or a body that is not one
    }
  }
  return fail(3, `HTTP ${res.status} but the answer is not a JSON-RPC message: ${clean(text.slice(0, 200))}`)
}

// Calls the tool `name` with `args` and returns the tool's result ({content: [...], isError}).
export async function callTool(url, token, name, args) {
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "x-bonez-mcp-consumer": "plugin-push",
  }
  const post = async (body) => {
    const { res, text } = await send(url, { method: "POST", headers, body: JSON.stringify(body) })
    if (redirected(res)) fail(3, `${url} redirected the request (HTTP ${res.status}); not following it with your sign-in. Check BONEZ_URL`)
    if (res.status >= 400) throw new HttpRefusal(res.status, res.headers.get("www-authenticate") ?? "", text)
    return { res, text }
  }
  const result = (reply, id, what) => {
    const m = message(reply.res, reply.text, id)
    if (m.error) fail(3, `the server's MCP endpoint refused ${what}: ${clean(m.error.message ?? JSON.stringify(m.error)).slice(0, 500)}`)
    return m.result ?? {}
  }

  const hello = await post({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "bonez-plugin-push", version: "1" } },
  })
  const agreed = result(hello, 1, "initialize")
  const session = hello.res.headers.get("mcp-session-id")
  if (session) headers["mcp-session-id"] = session
  headers["mcp-protocol-version"] = agreed.protocolVersion ?? PROTOCOL
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  return result(await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }), 2, name)
}
