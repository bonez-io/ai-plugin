// Which Bonez CLI client a sign-in uses. The command-line sign-ins (bonez-plugin-push, session capture) ask the
// gateway they talk to: its /auth/config names the CLI client of the Auth0 tenant it signs in with
// (auth0.cli_client_id). The static MCP configs cannot ask, so they name the id of Bonez's hosted service, and the
// gateway's install script swaps that exact string for its own client wherever it writes a copy
// (Cursor's plugin folder, Codex's config.toml). These tests pin both halves.
//
// Offline: the gateway is a local http server on 127.0.0.1.
// Run: node --test tests/client_id.test.mjs   (or ./tests/test_client_id.sh)
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { gatewayClientId, SHIPPED_CLIENT_ID } from "../bin/lib/client-id.mjs"
import { CLIENT_ID } from "../bin/lib/signin.mjs"

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..")
const read = (...p) => readFileSync(join(REPO, ...p), "utf8")
const json = (...p) => JSON.parse(read(...p))

// A gateway whose /auth/config is whatever `answer` does with the response.
async function gateway(answer) {
  const server = createServer((req, res) => {
    if (req.url !== "/auth/config") {
      res.writeHead(404)
      return res.end()
    }
    answer(res)
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return { url, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections() }) }
}
const config = (body) => (res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(typeof body === "string" ? body : JSON.stringify(body))
}

describe("gatewayClientId: the client the gateway names for its authorization server", () => {
  const ISSUER = "https://auth.server.example/"
  const cases = [
    ["names it for the same authorization server", config({ mode: "auth0", auth0: { domain: "auth.server.example", client_id: "web", cli_client_id: "serverCliClient" } }), "serverCliClient"],
    ["names it with a scheme and a trailing slash on the domain", config({ auth0: { domain: "https://Auth.Server.example/", cli_client_id: " serverCliClient " } }), "serverCliClient"],
    ["names none (a gateway from before the field)", config({ mode: "auth0", auth0: { domain: "auth.server.example", client_id: "web" } }), undefined],
    ["names one for another authorization server", config({ auth0: { domain: "auth.other.example", cli_client_id: "otherCli" } }), undefined],
    ["names one with no domain to check it against", config({ auth0: { cli_client_id: "serverCliClient" } }), undefined],
    ["names an empty one", config({ auth0: { domain: "auth.server.example", cli_client_id: "  " } }), undefined],
    ["has no Auth0 sign-in at all", config({}), undefined],
    ["answers something that is not JSON", config("<html>"), undefined],
    ["fails", (res) => { res.writeHead(500); res.end() }, undefined],
    ["redirects (never followed)", (res) => { res.writeHead(302, { location: "https://evil.example/auth/config" }); res.end() }, undefined],
  ]
  for (const [label, answer, expected] of cases) {
    test(`a gateway that ${label}: ${expected ?? "none (the shipped one is used)"}`, async () => {
      const gw = await gateway(answer)
      try {
        assert.equal(await gatewayClientId(gw.url, ISSUER), expected)
      } finally {
        await gw.close()
      }
    })
  }

  test("a gateway that does not answer in time: none, without waiting for it", async () => {
    const gw = await gateway(() => {}) // never answers
    try {
      const t0 = Date.now()
      assert.equal(await gatewayClientId(gw.url, ISSUER, { timeoutMs: 200 }), undefined)
      assert.ok(Date.now() - t0 < 2_000)
    } finally {
      await gw.close()
    }
  })

  test("a gateway that cannot be reached: none, and no throw", async () => {
    assert.equal(await gatewayClientId("http://127.0.0.1:1", ISSUER), undefined)
  })
})

describe("the shipped client id is written once, and every static config names exactly it", () => {
  test("the push tool's fallback is the shipped one", () => {
    assert.equal(CLIENT_ID, SHIPPED_CLIENT_ID)
  })

  test("no code in bin/ spells the id except bin/lib/client-id.mjs", () => {
    const hits = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name)
        if (e.isDirectory()) walk(path)
        else if (readFileSync(path, "latin1").includes(SHIPPED_CLIENT_ID)) hits.push(relative(REPO, path).split("\\").join("/"))
      }
    }
    for (const bin of ["bin", "cursor/bin", "codex/bin"]) walk(join(REPO, bin))
    assert.deepEqual(hits.sort(), ["bin/lib/client-id.mjs", "codex/bin/lib/client-id.mjs", "cursor/bin/lib/client-id.mjs"])
  })

  // The install script swaps the shipped id for the gateway's own client as a plain string. A file
  // that names any other id is left on that one after the swap, and its tool cannot sign in on that gateway.
  // Each of these points at Bonez's hosted service, whose sign-in the shipped id belongs to: Codex and Cursor expand no
  // variables in them, so the id cannot be looked up at run time.
  const STATIC = [
    ["codex/.mcp.json (the Codex plugin; for another gateway the script writes config.toml, which replaces it)",
      () => json("codex", ".mcp.json").mcpServers.bonez, (s) => s.oauth.client_id],
    ["cursor/mcp.json (the Cursor plugin the script copies and swaps)",
      () => json("cursor", "mcp.json").mcpServers.bonez, (s) => s.auth.CLIENT_ID],
    ["cursor-directory/mcp.json (the Cursor Marketplace copy: Bonez's own cloud only, never installed by the script)",
      () => json("cursor-directory", "mcp.json").mcpServers.bonez, (s) => s.auth.CLIENT_ID],
  ]
  for (const [label, server, clientId] of STATIC) {
    test(label, () => {
      const s = server()
      assert.equal(clientId(s), SHIPPED_CLIENT_ID)
      assert.equal(s.url, "https://gateway.bonez.io/mcp")
    })
  }

  test("codex/config.toml (pasted by hand) names it too", () => {
    const ids = [...read("codex", "config.toml").matchAll(/^client_id = "([^"]*)"/gm)].map((m) => m[1])
    assert.deepEqual(ids, [SHIPPED_CLIENT_ID])
  })

  test("after the install script's swap, the Cursor plugin names only the gateway's client", () => {
    // The script's bake: sed -e "s|$SHIPPED_CLIENT_ID|$CLIENT_ID|g" over the copied mcp.json.
    const baked = read("cursor", "mcp.json").replaceAll(SHIPPED_CLIENT_ID, "serverCliClient")
    assert.equal(JSON.parse(baked).mcpServers.bonez.auth.CLIENT_ID, "serverCliClient")
    assert.ok(!baked.includes(SHIPPED_CLIENT_ID))
  })
})
