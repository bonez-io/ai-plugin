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

- Publisher display name: Bonez; all countries, as selected by Shay. Match the
  actual verified developer identity in Platform before submission.
- No purchase/checkout flow in this plugin. It requires an existing Bonez account
  with access to an organization and its connected data.
- Website: public ai-plugin repository. The support, privacy and terms pages at
  bonez.io were opened and checked on 16 November 2026. This was a content check,
  not an audit of backend retention or a new legal attestation.
- MCP endpoint: `https://gateway.bonez.io/mcp`. Protected-resource discovery and
  Auth0 discovery were verified. Public dynamic client registration, PKCE S256,
  email-code sign-in, token exchange, initialize and authenticated tools/list
  succeeded in a development connection on 16 November 2026. The ordinary MCP exposes 24 top-level tools, including generic vendor discovery/read/write and environment management. Release acceptance must verify the inventory and boolean annotations against the deployed gateway.
- The package requests `bonez:read`, `bonez:memory`, `bonez:write`. It includes no
  client secret, custom MCP headers or native CLI client/callback override. Platform's actual
  callback and saved connection must still be tested independently.

## Review fixtures and demonstration

The five positive cases cover evidence search/fetch, live Linear reads, workspace/rules/agent/environment orientation, code callers/test relationships and an authorized personal memory. The portal requires exactly five positive cases; workspace orientation includes environment discovery/read.
Three negative cases cover access boundaries, credential extraction and
unsupported public-plugin server administration. Expectations distinguish
indexed/heuristic relationships from runtime coverage and a pending or retired
memory from an active one.

Use the dedicated synthetic PayZeno reviewer workspace. Its seed repository is
`payzeno-showcase-pilot-01/payzeno-showcase-pilot-01`, commit
`bbbd0722d407142c06af528941b01161e81f097f`: README.md, ledger.py and test_ledger.py.
PAY-5 and the sample payment discussion describe duplicate webhook settlement.
No customer repository or real payment data is required. Reviewer identity and
login instructions belong only in Platform's secure access fields, never here
or in the ZIP. The current Platform form explicitly supports its designated
reviewer mailbox with magic-link/email-code sign-in, matching Plugin Creator's
review-materials guidance. Use that supported form option for the prepared
sample-workspace invitation; do not require access to the creator's mailbox.
The generic submission documentation currently disagrees with this UI, so do
not redesign account authentication based on that prose alone.

The development rehearsal loads the exact generated skills through Codex's local
skill discovery and connects the same production MCP endpoint with the approved
sample account. This is a manual development installation, not a saved Platform
connection. The demo records the live Codex CLI with asciinema and converts that
real timed terminal recording to video. It must not be replaced by fabricated
answers, reconstructed tool output or a script passed off as a recording.
Verify readable playback and absence of credentials before hosting the video;
put the verified URL in `review.demo_recording_url` and rebuild the archive.

The memory case creates only a personal test preference. Fetch it after saving
and report its actual state; close it after the rehearsal with its returned ID.
A closed or rejected memory is not proof of successful future recall.

## Final Platform setup

Upload the final ZIP as a draft, verify imported metadata and server/skill
inventory, complete OAuth, and run all cases on that exact saved version. Check
country targeting, developer/domain verification, scans and reviewer access.
A provisioned reviewer invitation is not evidence that the reviewer has signed
in; use the reviewer's own email-code flow and keep sample access working.

The authorized developer completes legal/policy attestations. Uploading creates
a draft; submitting for review and publishing an approved release are separate.
Keep Linear 1SI-3800 under 1SI-3067 updated with actual results and remaining gates.

References:
- https://developers.openai.com/plugins/build/plugins
- https://developers.openai.com/plugins/deploy/submission

Platform upload on 16 November 2026 rejected custom MCP `headers`, even though
they are part of the portable transport format. The OpenAI builder therefore
omits Bonez consumer/version telemetry headers; authentication remains declared
only in `extensions.com.openai.auth`.

OAuth uses explicit `client.mode: "dcr"`. Leaving registration selection implicit
made Platform send the CIMD client ID `https://chatgpt.com/oauth/client.json`,
which the current Auth0 tenant rejected as unknown. DCR is supported and was
exercised in the development connection; verify Platform's saved settings after
each upload before reconnecting.

## Interface decision and review risk

Use the same `/mcp` endpoint and capabilities as other Bonez clients. The earlier
38-tool directory adapter removed most vendor operations and environment writes;
Shay rejected that tradeoff. Public packaging must not reinstate a provider
allowlist or remove operations merely to avoid advisory findings.

The compact interface discovers operations and their schemas on demand, then
runs them through separate read and write tools. It retains existing scope,
tenancy, binding, schema and approval enforcement. It does not execute arbitrary
caller-supplied code. Direct environment tools and the complete memory operation
union remain available. Memory's destructive hint covers revisions, unlink and
retirement; history retention does not make those actions non-destructive.

Research checked 16 November 2026:

- [PostHog's MCP source](https://github.com/PostHog/posthog/blob/master/services/mcp/README.md)
  documents a default CLI `exec` surface for OpenAI clients and an optional
  per-operation tools mode. This supports compact discovery as a practical
  design; it does not establish Bonez's eligibility or an exception.
- [Cloudflare Code Mode](https://developers.cloudflare.com/agents/tools/codemode/api-reference/)
  supports discovery/description plus execution with controlled host access.
  Bonez reuses its typed operation dispatcher rather than introducing a code runtime.
- [OpenAI's guideline](https://developers.openai.com/plugins/plugin-guidelines)
  asks for separately exposed operations and disallows using generic discovery
  and execution to enable operations not exposed for review. The conflict is
  explicit. Do not describe the compact package as policy-compliant or guaranteed
  acceptance; submit accurate capability descriptions and disclose the scan
  advisories for review. Do not conceal tools from reviewers or vary behavior by
  reviewer identity or client User-Agent.

The original draft had zero blocking findings and seven advisories, not an
approval. After the full-capability server release, the fresh scan cleared both
environment annotation findings. Generic-interface advisories still need explicit
review; do not interpret a non-blocking scan result as policy approval.

An earlier restricted-profile memory rehearsal saved the wrong repository path;
later readback also changed from personal to organization scope after retirement.
The test note was retired. Core PR2370 prevents personal-memory review from
widening its owner audience. Production acceptance on 16 November 2026 verified
the exact requested file and preference through pending, active and retired
states, including delayed active and retired readbacks; every read remained
personal. Evidence and the bounded acceptance results are tracked in 1SI-3828.
This does not establish a retrospective audit of historical memories.
