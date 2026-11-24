# Bonez for the OpenAI public directory

The public upload contains eleven remote skills and one Bonez Cloud MCP server.
Build it separately from the native Claude, Cursor and Codex distributions.
OpenAI public submissions do not accept the local lifecycle hooks, session
capture or plugin-building utilities in those distributions.

`metadata.json` owns the listing, review cases and publication settings. Identity
comes from `codex/.codex-plugin/plugin.json`; the public release version is in
`version`. The existing 512px PNG supplies both listing icons. Two public skill
overrides in `skills/` explain the complete vendor/environment interface and
authorized memory workflows. The other nine remote skills come from `claude-directory/`.
The public package requires explicit memory authorization and write readback.


## Build and inspect the actual archive

Use a new absolute output parent. The builder refuses to overwrite an existing
`bonez` directory. Regenerate `claude-directory/` first if source skills changed.

```sh
node scripts/build-openai-plugin.mjs /absolute/output/bonez
python3 -m zipfile -c /absolute/output/bonez.zip /absolute/output/bonez
uv run --no-project --with pyyaml --with pillow python scripts/validate-openai-plugin.py /absolute/output/bonez.zip --require-review-materials
```

The validator reads the ZIP itself: paths, JSON, YAML frontmatter, icon bytes,
version, MCP transport/scopes, workflow inventory and review metadata. CI builds
and validates a fresh ZIP. Local success does not establish Platform acceptance,
OAuth approval, reviewer login, passed portal cases or publication approval.

## Listing and authentication

- No purchase/checkout flow in this plugin. It requires an existing Bonez account
  with access to an organization and its connected data.
- MCP endpoint: `https://gateway.bonez.io/mcp`, with protected-resource discovery.
- The package requests `bonez:read`, `bonez:memory`, `bonez:write`. It includes no
  client secret, custom MCP headers or native CLI client/callback override.
- Platform rejects custom MCP `headers`, even though they are part of the portable
  transport format, so the OpenAI builder omits the Bonez consumer/version headers.
  Authentication is declared only in `extensions.com.openai.auth`.
- OAuth uses explicit `client.mode: "dcr"`. Leaving registration selection implicit
  makes Platform send a CIMD client ID, which the Bonez sign-in does not accept.

## Review cases

The five positive cases cover evidence search/fetch, live Linear reads,
workspace/rules/agent/environment orientation, code callers/test relationships and
an authorized personal memory. Three negative cases cover access boundaries,
credential extraction and unsupported public-plugin server administration.
Expectations distinguish indexed/heuristic relationships from runtime coverage and
a pending or retired memory from an active one.

The cases run against a synthetic review workspace (a seeded sample ledger
repository, ticket and discussion); no customer data is used. Reviewer access
details belong only in Platform's secure access fields, never here or in the ZIP.

## Interface

The package uses the same `/mcp` endpoint and capabilities as other Bonez clients.
The compact interface discovers operations and their schemas on demand, then
runs them through separate read and write tools. It retains existing scope,
tenancy, binding, schema and approval enforcement. It does not execute arbitrary
caller-supplied code. Direct environment tools and the complete memory operation
union remain available. Memory's destructive hint covers revisions, unlink and
retirement; history retention does not make those actions non-destructive.

References:
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission
- https://developers.openai.com/plugins/plugin-guidelines
