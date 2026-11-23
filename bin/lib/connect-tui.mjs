// The installer's terminal view (1SI-4098): the screen install.sh hands over to (`install-ui`), what `connect`
// shows while it waits for the person in the browser, and the demo that plays it all with fake timing
// (`connect --demo`).
//
// Bonez's look, as in libs/ui/DESIGN.md §2 of bonez-core: ink and paper, sentence case, colour only for
// state. Titles are bold, everything secondary is dim, and only the marks are coloured: ✓ green (done),
// ✗ red (failed), the spinner yellow (working), · and – grey (to do, skipped). Words and the wordmark are
// never coloured. Everything sits on one left margin and stays inside the terminal's width.
//
// Two ways to draw it:
// - On a terminal: a full screen, like a classic TUI. It takes the alternate screen, hides the cursor and
//   redraws the whole view in place on every change and on a resize, trimmed to the terminal's height (the
//   header and the live line stay; the middle gives way). On the way out, however it ends (done, Ctrl-C, an
//   error, the window closing), it gives the screen back and leaves a short summary in the scrollback.
// - Anything else (a pipe, a log, CI, TERM=dumb): plain lines, no escape codes. NO_COLOR drops the colour.
// A Windows console that is not Windows Terminal gets ASCII marks and the word "bonez" for the wordmark.
// Links are OSC 8 hyperlinks only in terminals known to show them.

const ESC = "\x1b["

// The Bonez wordmark, the mark and "bonez" (`Logo` in bonez-core libs/ui/src/components/logo.tsx, viewBox
// 0 0 154 34), drawn in quadrant blocks by scripts/terminal-mark.mjs from its SVG paths, 4 rows tall (at 3 its
// letters do not read). Regenerate with that script when the logo changes, and copy the --sh form into install.sh.
export const WORDMARK = [
  "▝▀▙▄▟▛▘ ▐▌",
  "▗█▀ ▀█▖ ▐█▀▀▜▄ ▟▛▀▜▄▗█▞▀▜▙▗▟▀▀█▖▀▀▀█▌",
  "▝▜▄ ▄▛▘ ▐▌   █▐█   █▐█  ▐█▐█▀▀▀▘ ▄▛▘",
  "▗▟▀ ▀▙▖ ▐█▄▄▟▀ ▜▙▄▟▀▝█  ▐█▝▜▄▄▟▘▟█▄▄▖",
]
export const SUBTITLE = "Connecting your coding tools"

const LINK_TERMINALS = new Set(["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby", "rio"])

// BONEZ_FORCE_TTY=1 draws the full screen into a pipe: for the tests and the screenshots only.
export function terminalCaps({ stream = process.stdout, env = process.env, platform = process.platform } = {}) {
  const forced = env.BONEZ_FORCE_TTY === "1"
  const tty = forced || (Boolean(stream?.isTTY) && env.TERM !== "dumb" && !env.CI)
  const unicode = platform !== "win32" || Boolean(env.WT_SESSION || env.TERM_PROGRAM)
  const links =
    tty &&
    (LINK_TERMINALS.has(env.TERM_PROGRAM) ||
      Boolean(env.WT_SESSION || env.KONSOLE_VERSION) ||
      /kitty/.test(env.TERM ?? "") ||
      Number(env.VTE_VERSION) >= 5000)
  const cols = Number(stream?.columns) || Number(env.COLUMNS) || 80
  return {
    live: tty,
    color: tty && env.NO_COLOR === undefined,
    unicode,
    links,
    cols,
    width: Math.max(60, Math.min(cols, 120)),
    height: Number(stream?.rows) || Number(env.LINES) || 24,
  }
}

const GLYPHS = {
  unicode: { done: "✓", failed: "✗", skipped: "–", todo: "·", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], full: "━", empty: "─", box: ["╭", "╮", "╰", "╯", "─", "│"], ellipsis: "…", sep: "›", out: "↗", to: "→" },
  ascii: { done: "+", failed: "x", skipped: "-", todo: ".", spinner: ["|", "/", "-", "\\"], full: "=", empty: "-", box: ["+", "+", "+", "+", "-", "|"], ellipsis: "...", sep: ">", out: "", to: "->" },
}

// An address in a line of text (a detail such as `Sign-in link: https://…`), up to a space or an escape code.
const URL_RE = /https?:\/\/[^\s\x1b]+/

// Visible length: escape codes (SGR, OSC 8) take no room.
const strip = (s) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
const visible = (s) => [...strip(s)].length

// Cut a styled line to `width` visible characters, keeping its escapes whole.
function cut(s, width) {
  if (visible(s) <= width) return s
  let out = ""
  let n = 0
  for (let i = 0; i < s.length; ) {
    const esc = /^(\x1b\]8;;[^\x1b]*\x1b\\|\x1b\[[0-9;?]*[A-Za-z])/.exec(s.slice(i))
    if (esc) {
      out += esc[0]
      i += esc[0].length
      continue
    }
    const ch = String.fromCodePoint(s.codePointAt(i))
    if (n >= width - 1) break
    out += ch
    n++
    i += ch.length
  }
  return `${out}…${ESC}0m`
}

// Word wrap of plain text to `width`.
function wrap(text, width) {
  const out = []
  let line = ""
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  out.push(line)
  return out
}

const NAME_W = 12
const STATE_W = 10
const M = "  " // the one left margin

// What both views draw with: styles, marks and the pieces of the screen, as lines.
function kit(caps) {
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
  const mark = { done: st.green(g.done), failed: st.red(g.failed), skipped: st.grey(g.skipped), todo: st.grey(g.todo) }
  const link = (label, url) => (caps.links ? `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\` : undefined)
  const panelW = () => Math.min(caps.width - M.length * 2, 76)
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
  }

  const k = {
    g,
    st,
    mark,
    link,
    panelW,
    // An address cut to `n` characters in the middle, so its host and its end both stay.
    shortUrl(url, n) {
      const keep = Math.max(0, n - g.ellipsis.length)
      return `${url.slice(0, Math.ceil(keep / 2))}${g.ellipsis}${url.slice(url.length - Math.floor(keep / 2))}`
    },
    header: (compact) =>
      compact || !caps.unicode
        ? [`${M}${st.bold("bonez")}  ${st.dim(SUBTITLE)}`]
        : [...WORDMARK.map((row) => `${M}${row}`), "", `${M}${st.dim(SUBTITLE)}`],

    // One tool: mark, name, state, and what to do next, dim, in columns. A next step too long for the width
    // goes under the state; details (a failure's own words) go under the name.
    tool({ state, name, word, next, details = [] }) {
      const head = `${M}${mark[state] ?? mark.todo} ${name.padEnd(NAME_W)}  ${word.padEnd(STATE_W)}`
      const out = []
      const nextText = next ? st.dim(next) : ""
      // The full screen leaves the last column empty (see `fit`).
      const room = caps.width - (caps.live ? 1 : 0)
      if (!next) out.push(head.trimEnd())
      else if (visible(head) + 1 + visible(nextText) <= room) out.push(`${head} ${nextText}`)
      else out.push(head.trimEnd(), `${" ".repeat(M.length + 2 + NAME_W + 2)}${nextText}`)
      for (const d of details) out.push(`${M}  ${st.dim(d)}`)
      return out
    },
    working: (name) => `${M}${st.yellow(g.todo)} ${name.padEnd(NAME_W)}  ${st.dim(`adding${g.ellipsis}`)}`,
    // The Claude app is optional: one dim line, a link to the prefilled connector where the terminal has links,
    // else the place to add it, short enough for 80 columns.
    claudeApp(url) {
      const linked = link(`Optional: add Bonez to the Claude app ${g.out}`.trim(), url)
      return `${M}${mark.todo} ${st.dim(linked ?? `Optional: Claude app ${g.to} claude.ai/customize/connectors`)}`
    },

    // "Finish in your browser": the steps, and why the terminal should stay open. A rounded panel on a terminal,
    // its words alone elsewhere. `tight` drops the blank rows (a short terminal).
    finish({ joining, url, opened }, tight = false) {
      const first = joining
        ? "Continue in the Bonez page you started from"
        : opened
          ? "Sign in on the Bonez page that just opened"
          : "Open the Bonez page below and sign in"
      const steps = [first, "Sign in to Bonez in each tool when it asks", "Choose whether Bonez saves your sessions"]
      const rows = steps.map((s, i) => [`${st.bold(String(i + 1))}  `, s])
      const textW = panelW() - 6 - 3
      const showUrl = !joining && url
      const urlInside = showUrl && url.length <= textW
      if (urlInside) rows.splice(1, 0, ["   ", url, opened ? st.dim : (s) => s])
      if (!tight) rows.push([])
      rows.push(["", "Keep this terminal open.", st.bold], ["", "It finishes setup when you answer in the browser."])
      rows.push(["", "Closing it is safe: it finishes the next time you use a coding tool.", st.dim])
      const out = k.panel("Finish in your browser", rows, tight)
      if (showUrl && !urlInside) out.push(`${M}${url}`)
      return out
    },

    // A rounded panel: a bold title in its top edge, rows of plain text wrapped to fit, one blank row inside the
    // top and the bottom edges. A row is [prefix, text, style]; a wrapped row hangs under its text.
    panel(title, rows, tight = false) {
      const inner = panelW() - 2
      const textW = inner - 4
      const [tl, tr, bl, br, h, v] = g.box
      if (!caps.live) {
        const plain = [`${M}${title}`]
        for (const [prefix = "", text = ""] of rows) {
          const pw = visible(prefix)
          wrap(text, textW - pw).forEach((p, i) => plain.push(p ? `${M}${i === 0 ? prefix : " ".repeat(pw)}${p}` : ""))
        }
        return plain
      }
      const pad = tight ? [] : [`${M}${v}${" ".repeat(inner)}${v}`]
      const lines = [`${M}${tl}${h} ${st.bold(title)} ${h.repeat(Math.max(1, inner - title.length - 3))}${tr}`, ...pad]
      for (const [prefix = "", text = "", style = (s) => s] of rows) {
        const pw = visible(prefix)
        wrap(text, textW - pw).forEach((p, i) => {
          const lead = i === 0 ? prefix : " ".repeat(pw)
          // A URL is a link where the terminal has them (the escapes take no room).
          const body = /^https?:\/\//.test(p) ? (link(style(p), p) ?? style(p)) : style(p)
          lines.push(`${M}${v}  ${lead}${body}${" ".repeat(Math.max(0, textW - pw - p.length))}  ${v}`)
        })
      }
      lines.push(...pad, `${M}${bl}${h.repeat(inner)}${br}`)
      return lines
    },

    event({ kind, text, detail }) {
      if (kind === "note") return `${M}  ${st.dim(text)}`
      return `${M}${mark[kind]} ${text}${detail ? `  ${st.dim(detail)}` : ""}`
    },

    // The live line: a spinner, the words, and the time waited and left under the panel's right edge; or the
    // sessions being added as a thin bar with the count.
    live(l, frame) {
      const spin = st.yellow(g.spinner[frame % g.spinner.length])
      if (l.type === "progress") {
        const count = `${l.done} of ${l.total}`
        const label = "Adding recent sessions"
        const barW = Math.max(10, panelW() - 2 - label.length - 2 - 2 - count.length)
        const n = l.total ? Math.round((l.done / l.total) * barW) : 0
        return `${M}${spin} ${label}  ${g.full.repeat(n)}${st.dim(g.empty.repeat(barW - n))}  ${st.dim(count)}`
      }
      const left = `${M}${spin} ${l.text}`
      const right = `${clock(Date.now() - l.t0)}${l.expiresAt ? ` · ${Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 60_000))} min left` : ""}`
      const gap = Math.max(2, M.length + panelW() - visible(left) - visible(right))
      return `${left}${" ".repeat(gap)}${st.dim(right)}`
    },
    allSet: (text) => `${M}${st.bold("All set.")} ${st.dim(text)}`,
  }
  return k
}

const DEFAULT_ALL_SET = "You can close this terminal and the setup page."
let active // the view on screen, so a crash anywhere can give the screen back

export function activeView() {
  return active
}

export function createView({ out = process.stdout, err = process.stderr, caps = terminalCaps({ stream: out }) } = {}) {
  return caps.live ? createScreen({ out, caps }) : createPlain({ out, err, caps })
}

// ------------------------------------------------------------------------------------------- plain

function createPlain({ out, err, caps }) {
  const k = kit(caps)
  const write = (s) => {
    try {
      out.write(s)
    } catch {
      /* nowhere to write */
    }
  }
  out.on?.("error", () => {})
  const line = (s = "") => write(`${s}\n`)
  let leaving
  const view = {
    caps,
    st: k.st,
    mark: k.mark,
    header() {
      line()
      for (const l of k.header()) line(l)
      line()
    },
    toolWorking() {},
    tool(state, name, word, next, details = []) {
      for (const l of k.tool({ state, name, word, next, details: [].concat(details) })) line(l)
    },
    detail(text) {
      line(`${M}  ${text}`)
    },
    claudeApp(url) {
      line(k.claudeApp(url))
    },
    finish(opts) {
      line()
      for (const l of k.finish(opts)) line(l)
      line()
    },
    waiting(text) {
      line(`${M}${k.mark.todo} ${text}`)
    },
    done: (text, detail) => line(k.event({ kind: "done", text, detail })),
    toolSignedIn: (name) => line(k.event({ kind: "done", text: `${name} signed in` })),
    skipped: (text, detail) => line(k.event({ kind: "skipped", text, detail })),
    note: (text) => line(k.event({ kind: "note", text })),
    // A failure ends the run: the bare words on stderr.
    fail(text) {
      try {
        err.write(`${text}\n`)
      } catch {
        /* nowhere to say it */
      }
    },
    progress() {},
    stopLive() {},
    allSet(text = DEFAULT_ALL_SET) {
      line()
      line(k.allSet(text))
      line()
    },
    setLeaving(note) {
      leaving = note
    },
    end({ interrupted } = {}) {
      if (interrupted && leaving) line(`${M}${leaving}`)
      leaving = undefined
    },
    close() {
      view.end()
    },
  }
  return view
}

// ------------------------------------------------------------------------------------------- full screen

function createScreen({ out, caps }) {
  const k = kit(caps)
  const m = { tools: [], working: undefined, claude: undefined, panel: undefined, events: [], live: undefined, final: undefined }
  let entered = false
  let ended = false
  let timer
  let frame = 0
  let leaving // what the summary says when it ends before the answer: { note, link }
  let lastRow // the tool row a `detail` belongs to

  const write = (s) => {
    try {
      out.write(s)
    } catch {
      /* the terminal is gone */
    }
  }
  out.on?.("error", () => {})

  // One line as the screen draws it (`s`, ready to write) and the rows it takes. The last column stays empty: a
  // line that fills it leaves the cursor waiting to wrap, and the erase after it would take its last character.
  // A line too long for the width is cut, except a link (install.sh's Codex sign-in link is ~300 characters).
  // Where the terminal shows links, its middle gives way and it still opens the whole address; elsewhere it is
  // drawn whole, over as many rows as it needs, so it can still be copied, and those rows count.
  function fit(l) {
    const room = caps.cols - 1
    const w = visible(l)
    if (w <= room) return { s: `${l}${ESC}K`, rows: 1 }
    const url = l.includes("\x1b]8;;") ? undefined : URL_RE.exec(l)?.[0]
    const keep = url ? url.length - (w - room) : 0
    if (url && caps.links && keep >= 20) return { s: `${l.replace(url, () => k.link(k.shortUrl(url, keep), url))}${ESC}K`, rows: 1 }
    if (url) return { s: w % caps.cols ? `${l}${ESC}K` : l, rows: Math.ceil(w / caps.cols) }
    return { s: `${cut(l, room)}${ESC}K`, rows: 1 }
  }
  const rowsOf = (lines) => lines.reduce((n, l) => n + l.rows, 0)

  // A tool's sign-in link (a detail with an address) stays on the screen, and in the summary, until the tool
  // says it is signed in.
  const links = (t) => t.details.filter((d) => URL_RE.test(d))
  const waitingOnLink = (t) => t.state !== "failed" && links(t).length > 0

  // The whole view, as tight as `level` asks: 0 everything, 1 the tools in one line, 2 a one-line header, 3 the
  // panel without its blank rows, 4 only the newest events.
  function compose(level, height) {
    const top = ["", ...k.header(level >= 2), ""].map(fit)
    const tools = []
    if (level >= 1 && m.panel) {
      const added = m.tools.filter((t) => t.state === "done" && !waitingOnLink(t)).map((t) => t.name)
      if (added.length) tools.push(`${M}${k.mark.done} ${added.join(", ")} ${k.st.dim("added")}`)
      for (const t of m.tools) {
        if (t.state === "failed") tools.push(...k.tool({ ...t, details: t.details.slice(0, 1) }))
        else if (waitingOnLink(t)) tools.push(...k.tool({ ...t, details: links(t) }))
      }
    } else {
      for (const t of m.tools) tools.push(...k.tool(t))
      if (m.working) tools.push(k.working(m.working))
      if (m.claude) tools.push(k.claudeApp(m.claude))
    }
    const panel = (m.panel ? ["", ...k.finish(m.panel, level >= 3)] : []).map(fit)
    let events = m.events.map((e) => fit(k.event(e)))
    const bottom = []
    if (m.live) bottom.push(k.live(m.live, frame))
    if (m.final) bottom.push("", k.allSet(m.final))
    const gap = m.events.length || m.live || m.final ? [fit("")] : []
    const middle = tools.map(fit)
    const end = bottom.map(fit)
    if (level >= 4) {
      const room = height - rowsOf(top) - rowsOf(middle) - rowsOf(panel) - rowsOf(gap) - rowsOf(end)
      if (rowsOf(events) > room) {
        const kept = []
        for (let i = events.length - 1; i >= 0 && rowsOf(kept) + events[i].rows <= room - 1; i--) kept.unshift(events[i])
        events = room > 1 ? [fit(`${M}  ${k.st.dim(`${k.g.ellipsis} ${events.length - kept.length} more`)}`), ...kept] : []
      }
    }
    return { top, middle: [...middle, ...panel, ...gap, ...events], bottom: end }
  }

  // Fits the terminal's height, in rows: the header and the live line stay, the middle gives way.
  function frameLines() {
    const height = Math.max(8, caps.height)
    for (let level = 0; level <= 4; level++) {
      const { top, middle, bottom } = compose(level, height)
      const all = [...top, ...middle, ...bottom]
      if (rowsOf(all) <= height) return all
      if (level === 4) {
        const taken = []
        for (const l of middle) {
          if (rowsOf(top) + rowsOf(taken) + l.rows + rowsOf(bottom) > height) break
          taken.push(l)
        }
        const out = []
        for (const l of [...top, ...taken, ...bottom]) if (rowsOf(out) + l.rows <= height) out.push(l)
        return out
      }
    }
    return []
  }

  function render() {
    if (!entered || ended) return
    write(`${ESC}H${frameLines().map((l) => l.s).join("\r\n")}${ESC}J`)
  }

  function resize() {
    const fresh = terminalCaps({ stream: out })
    if (out.columns) Object.assign(caps, { cols: fresh.cols, width: fresh.width })
    if (out.rows) caps.height = fresh.height
    render()
  }

  const onSignal = (signal, code) => () => {
    view.end({ interrupted: true })
    process.exit(signal === "SIGINT" && leaving ? 0 : code)
  }
  const crash = (e) => {
    view.fail(`Something went wrong: ${e instanceof Error ? e.message : String(e)}`)
    view.end()
    process.exit(1)
  }
  // Process-wide, so the screen is given back however the process ends; only while the screen is taken (from
  // the first draw to end()), and all of them are removed again by end().
  const handlers = {
    exit: () => view.end(),
    SIGINT: onSignal("SIGINT", 130),
    SIGTERM: onSignal("SIGTERM", 143),
    SIGHUP: onSignal("SIGHUP", 129),
    SIGWINCH: () => resize(),
    uncaughtException: crash,
    unhandledRejection: crash,
  }
  function enter() {
    if (entered || ended) return
    entered = true
    active = view
    write(`${ESC}?1049h${ESC}?25l${ESC}H${ESC}2J`)
    for (const [ev, fn] of Object.entries(handlers)) process.on(ev, fn)
    out.on?.("resize", resize)
  }
  const change = (fn) => {
    enter()
    fn()
    render()
  }
  const startTimer = () => {
    if (timer) return
    timer = setInterval(() => {
      frame++
      render()
    }, 80)
    timer.unref?.()
  }
  const stopTimer = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  // What stays in the scrollback once the screen is given back.
  function summary({ interrupted }) {
    const lines = ["", `${M}${k.st.bold("bonez")}  ${k.st.dim(SUBTITLE)}`, ""]
    // The rows and their next steps, in full. A failure keeps its details (its own words, the fix), and a tool not
    // yet signed in keeps its sign-in link.
    for (const t of m.tools) lines.push(...k.tool(t.state === "failed" ? t : { ...t, details: links(t) }))
    if (m.claude) lines.push(k.claudeApp(m.claude))
    if (m.events.length) lines.push("", ...m.events.map((e) => k.event(e)))
    if (m.final) lines.push("", k.allSet(m.final))
    else if (leaving && (interrupted || !m.events.some((e) => e.kind === "failed"))) {
      lines.push("", `${M}${k.mark.todo} ${leaving.note}`)
      if (leaving.link) lines.push(`${M}  ${leaving.link}`)
    }
    lines.push("")
    return lines
  }

  const view = {
    caps,
    st: k.st,
    mark: k.mark,
    // The header is always on the screen; this takes the screen.
    header: () => change(() => {}),
    toolWorking: (name) => change(() => (m.working = name)),
    // A row sent again under the same name replaces that row and its details (Codex: signed in after all).
    tool: (state, name, word, next, details = []) =>
      change(() => {
        m.working = undefined
        const row = { state, name, word, next, details: [].concat(details) }
        const at = m.tools.findIndex((t) => t.name === name)
        if (at >= 0) m.tools[at] = row
        else m.tools.push(row)
        lastRow = row
      }),
    detail: (text) => change(() => lastRow?.details.push(text)),
    // The gateway says a tool signed in: its sign-in link has done its job.
    toolSignedIn: (name) =>
      change(() => {
        const row = m.tools.find((t) => t.name === name)
        if (row) row.details = row.details.filter((d) => !URL_RE.test(d))
        m.events.push({ kind: "done", text: `${name} signed in` })
      }),
    claudeApp: (url) => change(() => (m.claude = url)),
    finish: (opts) => change(() => (m.panel = opts)),
    waiting: (text, expiresAt) =>
      change(() => {
        m.live = { type: "waiting", text, expiresAt, t0: Date.now() }
        startTimer()
      }),
    done: (text, detail) => change(() => m.events.push({ kind: "done", text, detail })),
    skipped: (text, detail) => change(() => m.events.push({ kind: "skipped", text, detail })),
    note: (text) => change(() => m.events.push({ kind: "note", text })),
    fail: (text) =>
      change(() => {
        m.live = undefined
        stopTimer()
        m.events.push({ kind: "failed", text })
      }),
    progress: (done, total) =>
      change(() => {
        m.live = { type: "progress", done, total }
        startTimer()
      }),
    stopLive: () =>
      change(() => {
        m.live = undefined
        stopTimer()
      }),
    allSet: (text = DEFAULT_ALL_SET) =>
      change(() => {
        m.live = undefined
        stopTimer()
        m.final = text
      }),
    // What the summary says if it ends before the answer arrives.
    setLeaving: (note, link) => (leaving = { note, link }),
    // Gives the screen back (cursor, the normal screen) and leaves the summary. Safe to call more than once.
    end({ interrupted = false } = {}) {
      if (ended) return
      ended = true
      stopTimer()
      if (active === view) active = undefined
      if (!entered) return
      for (const [ev, fn] of Object.entries(handlers)) process.off(ev, fn)
      out.off?.("resize", resize)
      write(`${ESC}?25h${ESC}?1049l`)
      write(summary({ interrupted }).join("\n") + "\n")
    },
    close() {
      view.end()
    },
  }
  return view
}

// ------------------------------------------------------------------------------------------- demo

const pause = (ms) => new Promise((r) => setTimeout(r, ms))

export const CLAUDE_CONNECTOR_DEMO_URL =
  "https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Bonez&connectorUrl=https%3A%2F%2Fgateway.bonez.io%2Fmcp"

// Plays the whole installer, install.sh's rows included, with fake timing. No network, no file, no tool is
// touched. `until` stops at one stage (for screenshots): adding, tools, waiting, signin, backfill, done; the
// screen is then given back as if the person pressed Ctrl-C.
export async function playDemo({ until, speed = 1, joining = false, out = process.stdout, caps } = {}) {
  const view = createView({ out, ...(caps && { caps }) })
  const g = view.caps.unicode ? GLYPHS.unicode : GLYPHS.ascii
  const t = (ms) => pause(ms / speed)
  const pairUrl = "https://app.bonez.io/settings/connect-tools?pair=K7QM-4XPA"
  const stopAt = async (stage) => {
    if (until !== stage) return false
    await t(1200)
    view.end({ interrupted: true })
    return true
  }
  view.setLeaving("Setup goes on in the background and finishes when you answer in the browser:", pairUrl)
  view.header()
  // install.sh's rows, word for word.
  const tools = [
    ["Claude Code", "added", `Next: /mcp ${g.sep} bonez ${g.sep} Authenticate`],
    ["Codex", "added", "Signed in"],
    ["Cursor", "added", `Next: reload, then MCPs ${g.sep} bonez ${g.sep} Authenticate`],
  ]
  for (const [name, word, next] of tools) {
    view.toolWorking(name)
    if (name === "Cursor" && (await stopAt("adding"))) return
    await t(700)
    view.tool("done", name, word, next)
  }
  view.tool("skipped", "OpenCode", view.st.dim("not found"))
  view.claudeApp(CLAUDE_CONNECTOR_DEMO_URL)
  if (await stopAt("tools")) return

  const expiresAt = Date.now() + 30 * 60_000
  view.finish({ joining, url: pairUrl, opened: !joining })
  view.waiting(`Waiting for you in the browser${g.ellipsis}`, expiresAt)
  if (until === "waiting") await t(2400) // a few seconds on the clock
  if (await stopAt("waiting")) return
  await t(1800)
  if (!joining) view.done("Signed in to Bonez in the browser")
  for (const name of ["Claude Code", "Cursor"]) {
    await t(900)
    view.done(`${name} signed in`)
  }
  if (await stopAt("signin")) return
  await t(1200)
  view.done("Session saving is on")
  const total = 37
  for (let i = 0; i <= total; i++) {
    view.progress(i, total)
    if (until === "backfill" && i === 23 && (await stopAt("backfill"))) return
    await t(70)
  }
  view.stopLive()
  view.done(`Added ${total} recent sessions`, "from the last 14 days")
  view.allSet()
  await t(until === "done" ? 1200 : 600)
  view.end()
}
