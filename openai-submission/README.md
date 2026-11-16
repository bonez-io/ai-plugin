# Bonez for the OpenAI public directory

The public upload contains eleven remote skills and one Bonez Cloud MCP server.
Build it separately from the native Claude, Cursor and Codex distributions.
OpenAI public submissions do not accept the local lifecycle hooks, session
capture or plugin-building utilities in those distributions.

`metadata.json` owns the listing, review cases and publication settings. Identity
and version come from `codex/.codex-plugin/plugin.json`; the existing 512px PNG
supplies both listing icons. The builder adapts the remembering skill to require
explicit user authorization and write readback, and aligns its operation/kind
examples with the live MCP schema. It does not promise a host approval policy.

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
  succeeded in a development connection on 16 November 2026. All 25 exposed
  tools declared boolean read-only, destructive and open-world annotations.
- The package requests `bonez:read`, `bonez:memory`, `bonez:write`. It includes no
  client secret or native CLI client/callback override. Platform's actual
  callback and saved connection must still be tested independently.

## Review fixtures and demonstration

The five positive cases cover evidence search/fetch, schema overview, an empty
rule set, code callers/test relationships and an authorized personal memory.
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
or in the ZIP.

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
