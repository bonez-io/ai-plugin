# Bonez for Cursor

The System Model is your organization's connected model of its code, tickets, people, services, agents and what they learned. Bonez keeps it, and this plugin connects Cursor to it over MCP.

## What it adds

- **Search**: one query across code, docs, tickets, PRs, conversations and people.
- **Impact analysis**: who calls a function, what breaks if you change or delete it, which tests cover it.
- **Rules**: your organization's standing rules, applied when the agent reviews or writes code.
- **Memories**: durable facts your team saved, such as conventions and decisions. Saving one is a write, so Cursor's own tool-approval prompt applies.
- Commands: `/bonez-context`, `/bonez-search`, `/bonez-agents`.

## Sign in

Reload the window, then open **Customize > MCPs > bonez > Authenticate** and use your Bonez account. The plugin stores no key and runs no local code. It only talks to the Bonez server at https://gateway.bonez.io/mcp, sending headers with the plugin name and version. It needs no variables or configuration.

## Try it

- "Search Bonez for how we handle webhook retries."
- "What breaks if I rename `issueRefund`?"
- "Which rules apply to this pull request? Review it against them."

## Links

- Bonez: https://bonez.io
- Documentation: https://bonez.io/plugin/
- Source: https://github.com/bonez-io/ai-plugin
- Privacy policy: https://bonez.io/privacy
- Support: https://bonez.io/support/ or support@bonez.io

Customers who run their own Bonez server install from their server's install page instead of this plugin.
