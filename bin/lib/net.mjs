// What bonez-plugin-push and its helpers (signin.mjs, mcp.mjs) share: one way to fail with an exit code,
// one fetch wrapper that says what it tried, and the one place secrets are kept out of what is printed.
// Node built-ins only (Node 18+).

// What the CLI turns into its exit code and a one-line message on stderr. Anything else thrown is a bug.
export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export function fail(code, message) {
  throw new CliError(code, message)
}

// Server text goes to a terminal: drop control characters (escape sequences) but keep newlines, and never
// echo a key or a token even if a server (or a proxy in front of it) reflects the request.
const secrets = new Map() // value -> what to print in its place
export const hide = (value, label = "key") => {
  if (typeof value === "string" && value.length >= 8) secrets.set(value, label)
}
export const clean = (text) => {
  let shown = String(text).replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "?")
  for (const [value, label] of secrets) shown = shown.split(value).join(`[${label}]`)
  return shown
}

export const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"]
// https always; plain http only for this machine, or on a private network when the user says so.
export const isSecure = (url) =>
  url.protocol === "https:" || (url.protocol === "http:" && (LOOPBACK.includes(url.hostname) || process.env.BONEZ_ALLOW_HTTP === "1"))

// What node's TLS says when it does not know the server's certificate authority.
const UNTRUSTED_CERT = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED",
])
const WRONG_ADDRESS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

// POST/GET to `endpoint`; exits 3 with a message that names what was tried when nothing came back.
// A redirect is never followed, so a key or a token never goes to another place.
export async function send(endpoint, init, timeoutMs = 120_000) {
  try {
    const res = await fetch(endpoint, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), ...init })
    return { res, text: await res.text() }
  } catch (err) {
    const code = err?.cause?.code ?? err?.code
    const why = err?.name === "TimeoutError" ? `no answer within ${timeoutMs / 1000}s` : (code ?? err?.message ?? "unknown error")
    let hint = ""
    if (WRONG_ADDRESS.has(code)) hint = ". That address did not answer: check BONEZ_URL"
    else if (UNTRUSTED_CERT.has(code)) {
      hint = ". The server's certificate is not signed by an authority Node trusts (a self-signed or private-CA certificate). " +
        "Point NODE_EXTRA_CA_CERTS at your CA's .pem file and run this again " +
        '(bash: export NODE_EXTRA_CA_CERTS=/path/ca.pem; PowerShell: $env:NODE_EXTRA_CA_CERTS = "C:\\path\\ca.pem"). ' +
        "Do not switch certificate checking off: the key would go to whoever answers"
    }
    fail(3, `cannot reach ${endpoint}: ${clean(why)}${hint}`)
  }
}

export const redirected = (res) => res.status >= 300 && res.status < 400
