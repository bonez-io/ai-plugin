---
name: remembering
description: Saves durable facts into the org's memory with memory_save. Use when you learn something a teammate would want next time (a convention, a decision and its why, a non-obvious gotcha, a correction the user made), when the user says "remember", "from now on", "always" or "never", or when deciding whether something belongs in long-term memory. Offer to save it at the moment you learn it.
---

# Remembering

Memories written through `memory_save` live in the org's System Model, anchored to the records they are about, and surface in FUTURE sessions — yours and every other agent's in this org, in any harness. A good memory is one that will still be true, useful, and understandable next week with none of this conversation's context.

Saving is a PRIMARY action, not end-of-task cleanup. The moment you learn something durable, save it right then, while you can still phrase it well. Under-saving is the common failure: a fact you don't store is a mistake the whole org repeats.

`memory_save` is the only way to write. It takes typed operations — `remember`, `revise`, `claim`, `link`, `unlink`, `close` (and `note`, see below). There is no delete and no free-form mutation. The app's own tool-permission prompt asks before a write, so expect it to ask — that is working as intended, not an error. Writes need a key or sign-in with the `memory` scope; a read-only API key gets `memory_scope_required`, and an OAuth token without it is answered with an insufficient-scope challenge so the client can re-authorize.

## The shape of a `remember`

```json
{
  "op": "remember",
  "content": "The deploy script lives in infra/, not in the app repo.",
  "description": "Where the deploy script lives",
  "kind": "convention",
  "basis": "stated",
  "reason": "The user corrected my search path",
  "about": ["~a1b2c3d4"]
}
```

- `content` — the fact itself. One or two sentences that stand ALONE; resolve relative dates to absolute.
- `description` — one line, used wherever the memory is listed.
- `kind` — `preference`, `convention`, `decision`, `gotcha`, `procedure`, `context`, `claim` or `note`: what sort of memory this is.
- `basis` — `stated` (a person said it), `observed` (seen in code or data) or `inferred`.
- `reason` — required on EVERY op, 200 characters at most. Why this is worth keeping.
- `about` — at least one anchor that resolves to a real record: a `~hex` handle from `system_model_search`/`system_model_fetch`, a record key, or a URL. Anchor it to the record that actually describes the topic. If no relevant record resolves, say the note cannot be grounded yet instead of attaching an unrelated search result. An unresolvable anchor is refused with `anchor_unresolved`; never invent a handle.
- `scope` — `personal` (the default: only its owner sees it) or `org` (every member sees it). Choose `org` deliberately and confirm with the user first.
- `expiry` — typed clauses only, required for `kind: "context"` (a temporary status). Examples: `event:pr_merged(acme/payments-api#47)`, `event:ticket_done(ENG-102)`, `until:2026-12-31T00:00:00Z`, `idle:30d`. Free text is refused because it could never fire.

## Before you save: preflight

Duplicates are worse than nothing. Send the same `remember` with `"preflight": true` first: it writes NOTHING and returns the similar memories already in scope. Then choose — create the new one, `revise` the one that is already there, or do nothing. A successful `remember` returns the same list.

## Changing and retiring

- **revise** — a fact changed. `{"op": "revise", "memory": "m:…", "content": "<the whole new fact>", "description": "…", "basis": "stated", "reason": "…", "if_rev": <the revision you read>}`. A revision re-sends the WHOLE fact, inherits the memory's kind and anchors, and `if_rev` makes the edit fail instead of overwriting a concurrent one.
- **close** — forget it, with a reason: `{"op": "close", "memory": "m:…", "reason": "…"}`. Nothing is ever hard-deleted.
- **claim** — an assertion about the System Model itself. When you believe an imported fact or relation is wrong, write a `claim` about it; imported records cannot be edited.
- **link / unlink** — connect or detach one of YOUR memories to another real record by a typed link (`memory`, `to`, `edge`); `system_model_schema(guide="memories")` names the link types.

The `m:…` id comes from the write's own result, from a `preflight`'s similar list, or from the attached-memories list on `system_model_fetch`.

## After you save: new memories start `pending`

A new memory is written in the `pending` state and becomes `active` only once the memory worker promotes it. `remember` and `revise` ask for that promotion right away (best effort); a `claim`, or a write whose nudge failed, waits for the scheduled pass — up to an hour. Until then the memory does NOT show in `system_model_search` memory counts or in the memories attached to its anchor. That is not a failed write: read it back with `system_model_fetch(ref="m:…")`, which returns it in any state you may see, and cite the handle the write returned. Do not re-send it. A retried `remember` is a duplicate, not a no-op, unless you pinned `if_commit`.

There is no tool that lists memories, and a query that names the memory plane is refused. To see what already exists, `system_model_search` the record it would be anchored to and read the attached memories on `system_model_fetch`.

## WHEN to remember

- The user tells you to. "Remember that…", "from now on…", "always/never…" is an explicit, non-negotiable save.
- A durable USER fact (`kind: preference`, personal scope): who they are, how they want you to work, a standing preference.
- FEEDBACK — a correction or confirmed-good approach. Save the correction AND the reason, so future sessions apply the principle, not just the instance.
- A durable ORG fact (`convention`, `decision`, `procedure`, `gotcha`): applies beyond this task. Org scope only after the user agrees.
- A temporary status worth carrying (`kind: context`) — with an `expiry` that will actually fire.

## WHEN NOT

- One-off details that only matter to the task in front of you.
- Anything recoverable from the code or the System Model. Memory is for what is NOT re-derivable — if asked to remember something recoverable, save the non-obvious part (the why, the gotcha).
- `note` and `scope: "session"`. They are session scratch, which needs a verified interactive session; this connection has none, so `scope: "session"` is refused and a `note` without a scope is stored as a personal memory, not as disposable scratch. Use `remember`.

## NEVER STORE (hard rules)

- Secrets or credentials of ANY kind — passwords, API keys, tokens, connection strings, `.env` values — even if the user pastes one into chat. They belong in a secret store, never in memory.
- Sensitive personal data (health, ethnicity, religion, orientation, politics, precise location, financial account numbers) UNLESS the user explicitly and specifically asks.

## Before you save

- Sensitive, or contradicts something you already read? Confirm with the user first.
- Writes are rate-limited (a per-session and a per-caller budget; `quota_exceeded`). Consolidate instead of saving ten fragments.
