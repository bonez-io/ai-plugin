# Bonez

The System Model is your organization's connected model of its code, tickets, people, services, agents and what they learned. Bonez keeps it, and this plugin connects Claude to it.

## What it adds

- **Search**: one query across code, docs, tickets, PRs, conversations and people.
- **Impact analysis**: who calls a function, what breaks if you change or delete it, which tests cover it.
- **Rules**: your organization's standing rules, applied when Claude reviews or writes code.
- **Memories**: durable facts your team saved, such as conventions and decisions, available to every session. Saving one is a write, so the app's own permission prompt applies.

## Sign in

The first time Claude uses Bonez it opens a sign-in page: use your Bonez account. The plugin stores no key and runs no local code. It only talks to the Bonez server at https://gateway.bonez.io/mcp, sending a header with the plugin name and version.

## Try it

- "Search Bonez for how we handle webhook retries."
- "What breaks if I rename `issueRefund`?"
- "Which rules apply to this pull request? Review it against them."

## Links

- Bonez: https://bonez.io
- Source and full documentation: https://github.com/bonez-io/ai-plugin
- Privacy policy: https://bonez.io/privacy
- Support: support@bonez.io

Customers who run their own Bonez server install from their server's install page instead of this plugin.
