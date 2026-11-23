// The installer's terminal view (1SI-4098): what `connect` prints while it waits for the person in the
// browser, and the demo that plays the whole installer with fake timing (`connect --demo a|b`).
//
// Bonez's look, as in libs/ui/DESIGN.md §2 of bonez-core: ink and paper, sentence case, colour only for
// state. Titles are bold, everything secondary is dim, and only the marks are coloured: ✓ green (done),
// ✗ red (failed), the spinner yellow (working), · and – grey (waiting, skipped). Words are never coloured.
//
// It degrades on its own: with no terminal (a pipe, a log, CI) or TERM=dumb there is no spinner, no
// redraw and no escape code, only plain lines; NO_COLOR drops the colour and keeps the spinner. A
// Windows console that is not Windows Terminal gets ASCII marks.
//
// Two looks, for the founder to choose from: "a" (a checklist and a spinner line) and "b" (the
// wordmark, a boxed panel and a progress bar). BONEZ_TUI=b picks the second until one is chosen.

const ESC = "\x1b["

export function terminalCaps({ stream = process.stdout, env = process.env, platform = process.platform } = {}) {
  const tty = Boolean(stream?.isTTY) && env.TERM !== "dumb" && !env.CI
  const unicode = platform !== "win32" || Boolean(env.WT_SESSION || env.TERM_PROGRAM)
  return {
    live: tty,
    color: tty && env.NO_COLOR === undefined,
    unicode,
    width: Math.max(40, Math.min(Number(stream?.columns) || 80, 100)),
  }
}

export function tuiVariant(env = process.env) {
  return env.BONEZ_TUI === "b" ? "b" : "a"
}

const GLYPHS = {
  unicode: { done: "✓", failed: "✗", skipped: "–", todo: "·", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], full: "━", empty: "─", box: ["╭", "╮", "╰", "╯", "─", "│"], ellipsis: "…" },
  ascii: { done: "+", failed: "x", skipped: "-", todo: ".", spinner: ["|", "/", "-", "\\"], full: "#", empty: "-", box: ["+", "+", "+", "+", "-", "|"], ellipsis: "..." },
}

// The wordmark, lowercase like the brand's. Drawn with box-drawing heavy strokes; ASCII consoles skip it.
export const WORDMARK = ["┏┓ ┏━┓┏┓╻┏━╸╺━┓", "┣┻┓┃ ┃┃┗┫┣╸ ┏━┛", "┗━┛┗━┛╹ ╹┗━╸┗━╸"]

// Visible length: escape codes take no room.
const visible = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length

export function createView({ variant = "a", out = process.stdout, err = process.stderr, caps = terminalCaps({ stream: out }) } = {}) {
  const g = caps.unicode ? GLYPHS.unicode : GLYPHS.ascii
  const sgr = (code, s) => (caps.color ? `${ESC}${code}m${s}${ESC}0m` : s)
  const st = {
    bold: (s) => sgr("1", s),
    dim: (s) => sgr("2", s),
    green: (s) => sgr("32", s),
    red: (s) => sgr("31", s),
    yellow: (s) => sgr("33", s),
    grey: (s) => sgr("90", s),
  }
  const mark = {
    done: st.green(g.done),
    failed: st.red(g.failed),
    skipped: st.grey(g.skipped),
    todo: st.grey(g.todo),
  }
  const pad = "  "
  let live // { text: () => string } while a live line is on screen
  let timer
  let frame = 0
  let drawn = false

  const write = (s) => {
    try {
      out.write(s)
    } catch {
      /* a closed terminal: nothing to draw on */
    }
  }
  const clearLive = () => {
    if (drawn) write(`\r${ESC}2K`)
    drawn = false
  }
  const drawLive = () => {
    if (!live || !caps.live) return
    write(`\r${ESC}2K${live.text()}`)
    drawn = true
  }
  // A permanent line: under a live line, it takes the live line's place and the live line comes back under it.
  const line = (s = "") => {
    clearLive()
    write(`${s}\n`)
    drawLive()
  }
  const spinner = () => st.yellow(g.spinner[frame % g.spinner.length])

  const startLive = (textFn) => {
    live = { text: textFn }
    if (!caps.live) return
    if (!timer) {
      write(`${ESC}?25l`) // hide the cursor while the spinner turns
      timer = setInterval(() => {
        frame++
        drawLive()
      }, 80)
      timer.unref?.()
    }
    drawLive()
  }
  const stopLive = () => {
    clearLive()
    live = undefined
    if (timer) {
      clearInterval(timer)
      timer = undefined
      write(`${ESC}?25h`)
    }
  }

  const minutesLeft = (expiresAt) => Math.max(0, Math.ceil((expiresAt - Date.now()) / 60_000))
  const bar = (done, total, width = 24) => {
    const n = total ? Math.round((done / total) * width) : 0
    return `${g.full.repeat(n)}${st.dim(g.empty.repeat(width - n))}`
  }

  function box(title, rows) {
    const inner = Math.min(caps.width - 6, 68)
    const [tl, tr, bl, br, h, v] = g.box
    const top = `${tl}${h} ${st.bold(title)} ${h.repeat(Math.max(1, inner - visible(title) - 3))}${tr}`
    const body = rows.map((r) => `${v}  ${r}${" ".repeat(Math.max(0, inner - 2 - visible(r)))}${v}`)
    return [top, `${v}${" ".repeat(inner)}${v}`, ...body, `${v}${" ".repeat(inner)}${v}`, `${bl}${h.repeat(inner)}${br}`]
  }

  const view = {
    caps,
    variant,
    st,
    mark,
    line,
    blank: () => line(""),

    // The demo's stand-in for install.sh's top lines (install.sh prints its own).
    header() {
      line()
      if (variant === "b" && caps.unicode) {
        for (const row of WORDMARK) line(`${pad}${st.bold(row)}`)
        line(`${pad}${st.dim("Adding Bonez to your coding tools")}`)
      } else {
        line(`${pad}${st.bold("bonez")}  ${st.dim("Adding Bonez to your coding tools")}`)
      }
      line()
    },

    // One tool in the checklist: its mark, its name, what happened, and what to do next (dim, under it).
    tool(state, name, what, next) {
      line(`${pad}${mark[state]} ${name.padEnd(12)} ${what}`)
      for (const n of [].concat(next ?? [])) line(`${pad}  ${" ".repeat(12)} ${st.dim(n)}`)
    },
    // As install.sh draws it: a still yellow dot (a POSIX shell has no spinner), replaced by the result.
    toolWorking(name) {
      if (!caps.live) return
      clearLive()
      write(`${pad}${st.yellow(g.todo)} ${name.padEnd(12)} ${st.dim(`adding${g.ellipsis}`)}`)
      drawn = true
    },

    // "Finish in your browser": the steps, and why the terminal should stay open.
    finish({ joining, url, opened }) {
      const first = joining
        ? "Go back to the Bonez page in your browser"
        : opened
          ? "Sign in on the Bonez page that just opened"
          : "Open this page and sign in:"
      const steps = [first, "Sign in to Bonez in each tool when it asks", "Choose whether Bonez saves your sessions"]
      const keep = "Keep this terminal open. It finishes setup when you answer in the browser."
      const safe = "Closing it is safe: setup then finishes the next time you use a coding tool."
      const showUrl = !joining && url
      if (variant === "b" && caps.unicode && caps.width >= 64) {
        line()
        const rows = steps.map((s, i) => `${st.bold(String(i + 1))}  ${s}`)
        rows.push("", st.bold("Keep this terminal open."), "It finishes setup when you answer in the browser.")
        for (const r of box("Finish in your browser", rows)) line(`${pad}${r}`)
        line(`${pad}  ${st.dim(safe)}`)
        if (showUrl) line(`${pad}  ${opened ? st.dim(url) : url}`)
        line()
        return
      }
      line()
      line(`${pad}${st.bold("Finish in your browser")}`)
      steps.forEach((s, i) => {
        line(`${pad}${st.bold(String(i + 1))}  ${s}`)
        if (i === 0 && showUrl) line(`${pad}   ${opened ? st.dim(url) : url}`)
      })
      line()
      line(`${pad}${st.bold(keep)}`)
      line(`${pad}${st.dim(safe)}`)
      line()
    },

    // The loader while the browser is away. Plain output gets the words once.
    waiting(text, expiresAt) {
      if (!caps.live) return line(`${pad}${mark.todo} ${text}`)
      startLive(() => {
        const left = expiresAt ? st.dim(`  ${minutesLeft(expiresAt)} min left`) : ""
        return `${pad}${spinner()} ${text}${left}`
      })
    },
    done(text, detail) {
      line(`${pad}${mark.done} ${text}${detail ? `  ${st.dim(detail)}` : ""}`)
    },
    skipped(text, detail) {
      line(`${pad}${mark.skipped} ${text}${detail ? `  ${st.dim(detail)}` : ""}`)
    },
    note(text) {
      line(`${pad}  ${st.dim(text)}`)
    },
    // A failure ends the run: on a terminal it is a ✗ line; otherwise the bare words on stderr.
    fail(text) {
      stopLive()
      if (caps.live) write(`${pad}${mark.failed} ${text}\n`)
      else {
        try {
          err.write(`${text}\n`)
        } catch {
          /* nowhere to say it */
        }
      }
    },
    // Adding the recent sessions: a counter (a) or a bar (b). Plain output gets the result line only.
    progress(done, total) {
      const label = `Adding recent sessions`
      startLive(() =>
        variant === "b"
          ? `${pad}${spinner()} ${label}  ${bar(done, total)}  ${st.dim(`${done}/${total}`)}`
          : `${pad}${spinner()} ${label}${g.ellipsis}  ${st.dim(`${done} of ${total}`)}`,
      )
    },
    stopLive,
    // Stop the spinner where it is and keep the line (the demo's screenshots).
    freeze() {
      if (timer) clearInterval(timer)
      timer = undefined
      if (drawn) write("\n")
      drawn = false
      live = undefined
      if (caps.live) write(`${ESC}?25h`)
    },
    allSet(text = "You can close this terminal and the setup page.") {
      stopLive()
      line()
      line(`${pad}${st.bold("All set.")} ${st.dim(text)}`)
      line()
    },
    close: stopLive,
  }
  return view
}

// ------------------------------------------------------------------------------------------- demo

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// Plays the whole installer, install.sh's steps included, with fake timing. No network, no file, no tool
// is touched. `until` stops at one stage and leaves it on screen (for screenshots): adding, tools,
// waiting, signin, backfill, done.
export async function playDemo({ variant = "a", until, speed = 1, out = process.stdout } = {}) {
  const view = createView({ variant, out })
  const t = (ms) => pause(ms / speed)
  const stopAt = async (stage) => {
    if (until !== stage) return false
    await t(1200)
    // Leave the frame as it is, spinner and all, for a capture.
    view.freeze()
    return true
  }
  view.header()
  // install.sh's rows, word for word.
  const tools = [
    ["Claude Code", "added", "Next: run /mcp, pick bonez, click Authenticate"],
    ["Codex", "added"],
    ["Cursor", "added", "Next: reload the window, then Customize > MCPs > bonez > Authenticate"],
  ]
  for (const [name, what, next] of tools) {
    view.toolWorking(name)
    if (name === "Cursor" && (await stopAt("adding"))) return
    await t(700)
    view.tool("done", name, what, next)
  }
  view.tool("skipped", "OpenCode", view.st.dim("not found"))
  view.tool("todo", "Claude app", "add Bonez as a connector for chat and Cowork:", "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Bonez…")
  if (await stopAt("tools")) return

  const expiresAt = Date.now() + 30 * 60_000
  view.finish({ joining: false, url: "https://app.bonez.io/settings/connect-tools?pair=K7QM-4XPA", opened: true })
  view.waiting(`Waiting for you in the browser${view.caps.unicode ? "…" : "..."}`, expiresAt)
  if (await stopAt("waiting")) return
  await t(1800)
  view.done("Signed in to Bonez in the browser")
  for (const name of ["Claude Code", "Codex", "Cursor"]) {
    await t(900)
    view.done(`${name} signed in`)
  }
  if (await stopAt("signin")) return
  await t(1200)
  view.done("Session saving is on")
  const total = 37
  for (let i = 0; i <= total; i++) {
    view.progress(i, total)
    if (until === "backfill" && i === 23) {
      await stopAt("backfill")
      return
    }
    await t(70)
  }
  view.stopLive()
  view.done(`Added ${total} recent sessions`, "from the last 14 days")
  view.allSet()
  if (until === "done") await t(400)
  view.close()
}
