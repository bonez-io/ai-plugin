---
name: using-vendor-operations
description: Read or change connected GitHub issues, Linear issues, GitHub pull requests, Slack channel history, and Bonez agents, runs or sessions using the public plugin's named tools. Use when the user requests an action in one of these connected services.
---

# Connected service operations

Use each named tool directly with its declared schema. The public interface is a fixed inventory; do not invent tool names, operation IDs or a generic executor. System Model searches return indexed evidence; named vendor tools read the connected service's current state.

- GitHub: `github_issue_list`, `github_issue_read`, `github_issue_create`, `github_issue_update`, `github_pull_request_list`, `github_pull_request_read`.
- Linear: `linear_issue_search`, `linear_issue_read`, `linear_issue_create`, `linear_issue_update`.
- Slack: `slack_message_history` reads channel messages. This interface cannot send messages.
- Bonez: `bonez_agent_list`, `bonez_agent_read`, `bonez_agent_create`, `bonez_agent_update`, `bonez_agent_run`; `bonez_trigger_list`, `bonez_trigger_options`; `bonez_environment_list`, `bonez_environment_read`; `bonez_run_list`, `bonez_run_read`; `bonez_session_list`, `bonez_session_read`.

Use `vendor_status` with a returned invocation ID to check a pending operation; it does not list account connections. Use returned resource identifiers and authorized connection references. If multiple accounts could match, resolve the user's intended target before writing. Never treat missing access as an empty result or search another organization to work around a refusal.

Read existing state before updating. Change only the fields and records requested. The user's explicit request authorizes its described action; clarify only missing consequential details. Creating/running an agent can cause future external actions: use `creating-an-agent` to make its instructions, triggers and permissions concrete first. Do not send messages, change other records or run agents as an incidental side effect of a read request.

Honor host permissions and server approval gates. If the server returns awaiting_approval, provide its approval URL and wait for the authorized person. Never approve your own request or claim completion before it occurs. On a permission, scope or connection error, explain the actual result and the needed account setup. Do not repeatedly retry or bypass it.

After a successful create/update, read the returned record to verify the requested fields. Distinguish a queued run from completion and show returned links. For unsupported providers or actions, explain the limitation and offer a draft or the Bonez web interface; do not promise capabilities the current tool list lacks.
