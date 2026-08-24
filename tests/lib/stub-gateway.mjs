// A minimal, dependency-free stand-in for the bonez gateway's import surface
// (POST /api/import/presign, PUT <presigned url>, POST /api/import/{id}/complete) —
// used because the real gateway change (1SI-1019) is merged but not yet deployed, and there's
// no accessible sessions-scoped key to test against (see the PR body for what real E2E needs).
// Records every call so tests can assert on headers, bodies, and call sequencing/counts.
import { createServer } from "node:http"

export function startStubGateway() {
  const calls = { presign: [], put: [], complete: [] }
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
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
