// A minimal, dependency-free stand-in for the bonez gateway's import surface
// (POST /api/import/presign, PUT <presigned url>, POST /api/import/{id}/complete) —
// used because the real gateway change (1SI-1019) is merged but not yet deployed, and there's
// no accessible sessions-scoped key to test against (see the PR body for what real E2E needs).
// Records every call so tests can assert on headers, bodies, and call sequencing/counts.
import { createServer } from "node:http"

export function startStubGateway() {
  const calls = { presign: [], put: [], complete: [], start: [], events: [], pairings: [], pairingJoin: [], pairingResult: [] }
  // The live-session routes answer with these; a test sets them to replay an old gateway (403).
  // `pairing` drives the connect flow's two public routes: each poll of /connect/pairing-result takes
  // the next of `steps` (the last one repeats); `sessions` is the answer, its key returned once.
  const answers = {
    start: 200, events: 200, authServer: null,
    pairing: { create: 201, join: 200, steps: ["waiting"], sessions: null, code: "K7QM-4XPA", secret: "s3cret-poll-token" },
  }
  let uploadSeq = 0

  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      const port = server.address().port

      if (req.method === "POST" && req.url === "/api/import/presign") {
        uploadSeq += 1
        const uploadId = `up-${uploadSeq}`
        let parsedBody = {}
        try {
          parsedBody = JSON.parse(body.toString("utf8") || "{}")
        } catch {
          /* leave {} — the assertion on parsedBody will just fail the test that cares */
        }
        calls.presign.push({ headers: { ...req.headers }, body: parsedBody })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(
          JSON.stringify({
            upload_id: uploadId,
            url: `http://127.0.0.1:${port}/put/${uploadId}`,
            key: `imports/test-org/test-user/${parsedBody.agent ?? "all"}/${uploadId}.tar.gz`,
            bucket: "test-import-bucket",
            content_type: "application/gzip",
            expires_in: 900,
          }),
        )
        return
      }

      const putMatch = req.url.match(/^\/put\/([^/]+)$/)
      if (req.method === "PUT" && putMatch) {
        calls.put.push({ headers: { ...req.headers }, body, uploadId: putMatch[1] })
        res.writeHead(200)
        res.end()
        return
      }

      const completeMatch = req.url.match(/^\/api\/import\/([^/]+)\/complete$/)
      if (req.method === "POST" && completeMatch) {
        calls.complete.push({ headers: { ...req.headers }, uploadId: completeMatch[1] })
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ upload_id: completeMatch[1], status: "uploaded" }))
        return
      }

      // Names an authorization server when a test sets one, so an OAuth refresh can be exercised.
      if (req.url === "/.well-known/oauth-protected-resource" && answers.authServer) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ resource: `http://127.0.0.1:${port}/mcp`, authorization_servers: [`${answers.authServer}/`] }))
        return
      }

      if (req.method === "POST" && req.url === "/connect/pairings") {
        const p = answers.pairing
        calls.pairings.push({ headers: { ...req.headers }, body: JSON.parse(body.toString("utf8") || "{}") })
        p.keyCollected = false
        res.writeHead(p.create, { "content-type": "application/json" })
        res.end(JSON.stringify(p.create === 201
          ? { code: p.code, secret: p.issuedSecret ?? p.secret, url: p.url ?? `http://127.0.0.1:${port}/connect?pair=${p.code}`, expires_at: Date.now() / 1000 + 1800, poll_interval: 2 }
          : { code: "not_found" }))
        return
      }

      // The Settings page's pairing: the installer joins it with `CODE.SECRET` (BONEZ_PAIR).
      if (req.method === "POST" && req.url === "/connect/pairings/join") {
        const p = answers.pairing
        const asked = JSON.parse(body.toString("utf8") || "{}")
        calls.pairingJoin.push({ headers: { ...req.headers }, body: asked })
        p.keyCollected = false
        const ok = asked.pair === `${p.code}.${p.secret}`
        const status = ok ? (p.join ?? 200) : 404
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(status === 200
          ? { code: p.code, url: `http://127.0.0.1:${port}/settings/connect-tools?pair=${p.code}`, expires_at: Date.now() / 1000 + 1800, poll_interval: 2 }
          : { code: status === 410 ? "pairing_expired" : "pairing_not_found" }))
        return
      }

      if (req.method === "POST" && req.url === "/connect/pairing-result") {
        const p = answers.pairing
        const asked = JSON.parse(body.toString("utf8") || "{}")
        calls.pairingResult.push(asked)
        if (asked.code !== p.code || asked.secret !== p.secret) {
          res.writeHead(404, { "content-type": "application/json" })
          res.end(JSON.stringify({ code: "pairing_not_found" }))
          return
        }
        const status = p.steps[Math.min(calls.pairingResult.length - 1, p.steps.length - 1)]
        let sessions = null
        if (status === "answered" && p.sessions) {
          sessions = { ...p.sessions, key: p.keyCollected ? null : (p.sessions.key ?? null) }
          p.keyCollected = true
        }
        res.writeHead(200, { "content-type": "application/json" })
        // `tools`: the per-tool sign-ins, a field the installer shows when the gateway sends it.
        res.end(JSON.stringify({ status, sessions, ...(p.tools && { tools: p.tools }) }))
        return
      }

      const sessionsMatch = req.url.match(/^\/graph\/sessions\/(start|events)$/)
      if (req.method === "POST" && sessionsMatch) {
        const route = sessionsMatch[1]
        calls[route].push({ headers: { ...req.headers }, body: JSON.parse(body.toString("utf8") || "{}") })
        res.writeHead(answers[route], { "content-type": "application/json" })
        res.end(JSON.stringify(route === "start" ? { state: "started" } : { accepted: 1 }))
        return
      }

      res.writeHead(404)
      res.end()
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        answers,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
