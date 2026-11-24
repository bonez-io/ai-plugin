// Which OAuth client a command-line sign-in uses: the Bonez CLI application of the Auth0 tenant the gateway signs
// in with. Shared by bonez-plugin-push (signin.mjs) and session capture (bonez-session-sync.mjs). Node 18+.
//
// The plugin ships the CLI client of Bonez's hosted service (SHIPPED_CLIENT_ID). A self-hosted or separate Bonez
// server whose sign-in uses a different Auth0 tenant names its own CLI client in its public /auth/config, as
// `auth0.cli_client_id`; the shipped id means nothing to that tenant. The authorization server itself (the Auth0
// domain) is never held here either: it comes from the gateway's protected-resource metadata.
//
// The static MCP configs cannot ask the gateway: codex/.mcp.json, cursor/mcp.json and cursor-directory/mcp.json
// name SHIPPED_CLIENT_ID, and the gateway's install script swaps it for its own client wherever it writes a copy
// (Cursor's plugin folder, Codex's config.toml). tests/client_id.test.mjs pins that they all name this one id.

// The public Bonez CLI application of Bonez's hosted service: an identifier, not a secret (RFC 8252 §8.5).
export const SHIPPED_CLIENT_ID = "qFX0bzskdcDBhbJaBBwGoiLN5yWkBrMm"

const host = (value) => String(value).trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase()

// The client id `origin`'s /auth/config names for the authorization server `issuer` (the URL its protected-resource
// metadata gave), or undefined: no answer, an older gateway that names none, or one for another authorization
// server, so an id is never sent to a tenant it does not belong to. Never throws, never follows a redirect, and
// gives up after `timeoutMs`; the caller then uses SHIPPED_CLIENT_ID.
export async function gatewayClientId(origin, issuer, { timeoutMs = 5_000 } = {}) {
  try {
    const res = await fetch(`${origin}/auth/config`, {
      headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status !== 200) return undefined
    const auth0 = (await res.json())?.auth0
    const id = typeof auth0?.cli_client_id === "string" ? auth0.cli_client_id.trim() : ""
    if (!id || typeof auth0.domain !== "string" || host(auth0.domain) !== new URL(issuer).host.toLowerCase()) return undefined
    return id
  } catch {
    return undefined
  }
}
