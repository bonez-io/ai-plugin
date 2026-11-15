// Preloaded with --import in a spawned CLI (and the workers it detaches, through NODE_OPTIONS):
// records every URL fetch is asked for, and answers none. Proves a refused gateway gets no call.
import { appendFileSync } from "node:fs"

globalThis.fetch = async (url) => {
  appendFileSync(process.env.BONEZ_TEST_FETCH_LOG, `${url}\n`)
  throw new Error("offline in this test")
}
