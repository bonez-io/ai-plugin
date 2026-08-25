// A stand-in for the two servers the uploader's OAuth lane talks to: the gateway's RFC 9728
// Protected Resource Metadata, and the Auth0 authorization server that document names.
//
// Both are served from ONE origin on purpose. `discoverAuthServer` reads the AS's issuer out
// of the gateway's own metadata rather than holding it as a constant, so a stub that answers
// both proves the discovery chain end to end — point the uploader at this origin as its
// gateway and it finds its way to the device and token endpoints with nothing hardcoded.
//
// Records every call so tests can assert on grant types, scopes, and poll behaviour.
import { createServer } from "node:http"

export function startStubOAuth({
  // How many times the token endpoint answers `authorization_pending` before it approves —
  // lets a test drive RFC 8628 §3.5 polling without waiting on real timings.
  pendingPolls = 0,
  interval = 0,
  refreshTokenOnLogin = "rt-1",
  rotateRefreshToken = null,
  denyWith = null,
} = {}) {
  const calls = { device: [], token: [], prm: 0, oidc: 0 }
  let polls = 0
  let issued = 0

  const json = (res, status, value) => {
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(value))
  }

  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const origin = `http://127.0.0.1:${server.address().port}`
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")))
      const path = req.url.split("?")[0]

      if (path === "/.well-known/oauth-protected-resource") {
        calls.prm += 1
        return json(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/`],
          scopes_supported: ["bonez:read", "bonez:memory", "bonez:write", "bonez:sessions"],
        })
      }

      if (path === "/.well-known/openid-configuration") {
        calls.oidc += 1
        return json(res, 200, {
          issuer: `${origin}/`,
          device_authorization_endpoint: `${origin}/oauth/device/code`,
          token_endpoint: `${origin}/oauth/token`,
        })
      }

      if (path === "/oauth/device/code") {
        calls.device.push(form)
        return json(res, 200, {
          device_code: "dc-1",
          user_code: "WXYZ-1234",
          verification_uri: `${origin}/activate`,
          verification_uri_complete: `${origin}/activate?user_code=WXYZ-1234`,
          expires_in: 900,
          interval,
        })
      }

      if (path === "/oauth/token") {
        calls.token.push(form)
        if (denyWith) return json(res, 403, { error: denyWith })
        if (form.grant_type === "refresh_token") {
          issued += 1
          return json(res, 200, {
            access_token: `at-refreshed-${issued}`,
            expires_in: 3600,
            ...(rotateRefreshToken ? { refresh_token: rotateRefreshToken } : {}),
          })
        }
        if (polls < pendingPolls) {
          polls += 1
          return json(res, 400, { error: "authorization_pending" })
        }
        return json(res, 200, {
          access_token: "at-1",
          expires_in: 3600,
          ...(refreshTokenOnLogin ? { refresh_token: refreshTokenOnLogin } : {}),
        })
      }

      json(res, 404, { error: "not_found" })
    })
  })

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        calls,
        close: () => new Promise((r) => server.close(r)),
      })
    })
  })
}
