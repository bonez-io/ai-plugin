import { captureOpenCode } from "../bin/bonez-session-sync.mjs"

export default {
  id: "bonez-capture",
  setup(ctx) {
    const controller = new AbortController()
    const { signal } = controller
    const events = ctx.event.subscribe({
      types: ["session.execution.succeeded", "session.execution.interrupted", "session.execution.failed"],
      signal,
    })
    const running = (async () => {
      for await (const event of events) {
        if (signal.aborted || (event.location && event.location.directory !== ctx.location.directory)) continue
        try {
          const sessionID = event.data.sessionID
          const session = await ctx.session.get({ sessionID })
          if (session.location?.directory !== ctx.location.directory) continue
          await captureOpenCode(session, () => ctx.session.context({ sessionID }))
        } catch {
          console.warn("Bonez: could not capture a completed OpenCode turn.")
        }
      }
    })().catch(() => { if (!signal.aborted) console.warn("Bonez: OpenCode event stream ended unexpectedly.") })
    return async () => { controller.abort(); await running }
  },
}
