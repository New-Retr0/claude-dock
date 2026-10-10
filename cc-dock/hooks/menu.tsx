import type { ClientModule } from 'claude-code'

// A row the menu draws: `action` says what Enter does (`toggle`, `cycle`, `expand`, or nothing).
export type MenuRow = {
  id: string
  label: string
  value: string
  action: 'toggle' | 'cycle' | 'expand' | 'none'
  note?: string
  details?: string[]
  heading?: boolean // a bold section title the cursor skips
  muted?: boolean // drawn dim: a value nothing can change
}

export type MenuTab = { id: string; label: string }

// One coloured piece of a header line.
export type Seg = { t: string; c?: string; d?: boolean; b?: boolean }

export type MenuProps = {
  rows: MenuRow[]
  labelWidth: number
  tabs?: MenuTab[]
  activeTab?: string
  hint?: string
  header?: Seg[][] // free-form coloured lines drawn between the hint and the rows
  accent?: string // the colour of ‹ ›, ▸ ▾, the tab brackets and the animated selector
}

type MenuState = {
  zone: 'list' | 'tabs'
  cursor: number
  tab: number
  top: number
  open: string[]
  frame: number
}

// The listeners are set once per instance; they read the newest props and layout through this ref
// instead of the closure of the render that set them.
type Latest = { props: MenuProps; rows: MenuRow[]; tabs: MenuTab[]; count: number; room: number; headerLines: number; lines: { row: MenuRow; detail?: string; index: number }[] }
const latestBySurface = new WeakMap<object, Latest>()

// The engine's own spinner frames, turning on whatever has the keyboard.
const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']
const fresh = (): MenuState => ({ zone: 'list', cursor: 0, tab: 0, top: 0, open: [], frame: 0 })

// The rows a text takes wrapped to `width` columns: words kept whole, one longer than a row broken across rows.
const wrappedRows = (text: string, width: number): number => {
  if (!(width > 0)) return 1
  let rows = 1
  let used = 0
  for (const word of text.split(' ')) {
    let len = word.length
    if (used > 0 && used + 1 + len <= width) {
      used += 1 + len
      continue
    }
    if (used > 0) rows += 1
    while (len > width) {
      rows += 1
      len -= width
    }
    used = len
  }
  return rows
}
// A header line is a row of coloured pieces; one longer than the pane spills onto further rows.
const lineRows = (segs: Seg[], width: number): number =>
  width > 0 ? Math.max(1, Math.ceil(segs.reduce((w, sg) => w + sg.t.length, 0) / width)) : 1

// Click the list to give it the keyboard. ↑↓ move through the rows; ↑ past the first row reaches the tab
// bar, where ←→ pick a tab and Enter opens it, ↓ returns to the list. On a row, Enter/→ go forward and ←
// back. A change posts `{ select, dir }` or `{ tab }` to the hooks module, which performs it.
const Menu: ClientModule<MenuProps, MenuState> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? fresh()
  const rows = props.rows
  const tabs = props.tabs ?? []
  const count = rows.length
  const header = props.header ?? []
  // The hint and the header lines wrap in a narrow pane; a click's row is counted from the real height above the list.
  const headerLines =
    (tabs.length > 0 ? 2 : 0) +
    (props.hint ? wrappedRows(props.hint, surface.columns) + 1 : 0) +
    header.reduce((n, segs) => n + lineRows(segs, surface.columns), 0)

  const lines: { row: MenuRow; detail?: string; index: number }[] = []
  rows.forEach((row, index) => {
    lines.push({ row, index })
    if (state.open.includes(row.id)) for (const d of row.details ?? []) lines.push({ row, detail: d, index })
  })
  const room = Math.max(3, (surface.rows || lines.length + headerLines) - headerLines)
  if (count > 0 && state.cursor > count - 1 && surface.state !== undefined) surface.setState({ ...state, cursor: count - 1 })
  if (surface.state !== undefined && rows[state.cursor]?.heading) {
    const firstRow = rows.findIndex((r, i) => i > state.cursor && !r.heading)
    if (firstRow >= 0) surface.setState({ ...state, cursor: firstRow })
  }
  const cursorLine = lines.findIndex(l => l.index === Math.min(state.cursor, Math.max(0, count - 1)) && l.detail === undefined)
  let top = state.top
  if (cursorLine < top) top = cursorLine
  if (cursorLine >= top + room) top = cursorLine - room + 1
  top = Math.max(0, Math.min(top, Math.max(0, lines.length - room)))

  latestBySurface.set(surface, { props, rows, tabs, count, room, headerLines, lines })
  const now = (): Latest => latestBySurface.get(surface) ?? { props, rows, tabs, count, room, headerLines, lines }
  const tabAt = (x: number): number => {
    const { tabs: ts } = now()
    let col = 0
    for (let i = 0; i < ts.length; i += 1) {
      const w = ts[i]!.label.length + 4
      if (x >= col && x < col + w) return i
      col += w + 2
    }
    return -1
  }
  const openRow = (s: MenuState, row: MenuRow, back: boolean) => {
    if (row.action === 'expand') {
      const isOpen = s.open.includes(row.id)
      if (back && !isOpen) return
      if (!back && isOpen) return
      surface.setState({ ...s, open: isOpen ? s.open.filter(id => id !== row.id) : [...s.open, row.id] })
    } else if (row.action === 'cycle') surface.post({ select: row.id, dir: back ? 'prev' : 'next' })
    else if (row.action === 'toggle') surface.post({ select: row.id })
  }

  if (surface.state === undefined) {
    surface.setState(fresh())
    surface.every(150, () => {
      const s = surface.state ?? fresh()
      surface.setState({ ...s, frame: (s.frame + 1) % SPIN.length })
    })
    surface.onKey(event => {
      const s = surface.state ?? fresh()
      const { props, rows, tabs, count, room } = now()
      if (s.zone === 'tabs') {
        if (event.key === 'left') surface.setState({ ...s, tab: Math.max(0, s.tab - 1) })
        else if (event.key === 'right') surface.setState({ ...s, tab: Math.min(tabs.length - 1, s.tab + 1) })
        else if (event.key === 'down') surface.setState({ ...s, zone: 'list' })
        else if (event.key === 'return' || event.key === ' ') {
          const t = tabs[s.tab]
          if (t) surface.post({ tab: t.id })
        }
        return
      }
      // Headings are skipped in whichever direction the cursor moves.
      const skip = (from: number, dir: 1 | -1): number => {
        // An empty tab has no row to move to: the cursor stays at the top.
        if (count <= 0) return 0
        let i = from
        while (i >= 0 && i < count && rows[i]?.heading) i += dir
        return i < 0 || i >= count ? Math.min(count - 1, Math.max(0, from - dir)) : i
      }
      if (event.key === 'up') {
        const first = rows.findIndex(r => !r.heading)
        if (s.cursor <= Math.max(0, first) && tabs.length > 0) {
          const active = Math.max(0, tabs.findIndex(t => t.id === props.activeTab))
          surface.setState({ ...s, zone: 'tabs', tab: active })
        } else surface.setState({ ...s, cursor: skip(Math.max(0, s.cursor - 1), -1) })
      } else if (event.key === 'down') surface.setState({ ...s, cursor: skip(Math.min(count - 1, s.cursor + 1), 1) })
      else if (event.key === 'pageup') surface.setState({ ...s, cursor: Math.max(0, s.cursor - room) })
      else if (event.key === 'pagedown') surface.setState({ ...s, cursor: Math.min(count - 1, s.cursor + room) })
      else if (event.key === 'home') surface.setState({ ...s, cursor: 0 })
      else if (event.key === 'end') surface.setState({ ...s, cursor: count - 1 })
      else if (event.key === 'return' || event.key === ' ' || event.key === 'right' || event.key === 'left') {
        const row = rows[s.cursor]
        if (row) openRow(s, row, event.key === 'left')
      }
    })
    surface.onPointer(event => {
      if (event.type !== 'down') return
      const s = surface.state ?? fresh()
      const { tabs, headerLines, lines } = now()
      if (tabs.length > 0 && event.y === 0) {
        const i = tabAt(event.x)
        if (i >= 0) {
          surface.setState({ ...s, zone: 'tabs', tab: i })
          surface.post({ tab: tabs[i]!.id })
        }
        return
      }
      const y = event.y - headerLines
      if (y < 0) return
      const hit = lines[s.top + y]
      if (!hit) return
      if (hit.index !== s.cursor || s.zone !== 'list') {
        surface.setState({ ...s, zone: 'list', cursor: hit.index })
        return
      }
      openRow(s, hit.row, false)
    })
  } else if (top !== state.top) {
    surface.setState({ ...state, top })
  }

  const glyph = SPIN[state.frame] ?? '·'
  const accent = props.accent ?? 'claude'
  const shown = lines.slice(top, top + room)
  return (
    <Box flexDirection="column">
      {tabs.length > 0 ? (
        <Box flexDirection="row" columnGap={2}>
          {tabs.map((t, i) => {
            const active = t.id === props.activeTab
            const focused = state.zone === 'tabs' && state.tab === i
            // `[ Name ]`: the active page's name bold white in orange brackets, the rest dim; the focused
            // one alternates its word with the spinner glyph.
            const showGlyph = focused && state.frame % 4 >= 2
            const inner = t.label.length
            const left = Math.floor((inner - 1) / 2)
            const word = showGlyph ? ' '.repeat(left) + glyph + ' '.repeat(inner - 1 - left) : t.label
            const lit = active || focused
            return (
              <Box key={`tab-${t.id}`} flexDirection="row">
                <Text bold={lit} color={lit ? accent : undefined} dimColor={!lit}>[ </Text>
                <Text bold={lit} color={showGlyph ? accent : lit ? 'text' : undefined} dimColor={!lit}>{word}</Text>
                <Text bold={lit} color={lit ? accent : undefined} dimColor={!lit}> ]</Text>
              </Box>
            )
          })}
        </Box>
      ) : null}
      {tabs.length > 0 ? <Text> </Text> : null}
      {props.hint ? <Text dimColor>{props.hint}</Text> : null}
      {props.hint ? <Text> </Text> : null}
      {header.map((segs, i) => (
        <Box key={`h-${i}`} flexDirection="row">
          {segs.length === 0 ? <Text> </Text> : segs.map((sg, j) => <Text key={`h-${i}-${j}`} color={sg.c} dimColor={sg.d} bold={sg.b}>{sg.t}</Text>)}
        </Box>
      ))}
      {shown.map((line, i) => {
        const here = state.zone === 'list' && line.index === state.cursor && line.detail === undefined
        if (line.detail !== undefined) {
          return (
            <Box key={`d-${line.row.id}-${i}`} flexDirection="row">
              <Text dimColor>{'     · '}{line.detail}</Text>
            </Box>
          )
        }
        const row = line.row
        if (row.heading) {
          return (
            <Box key={`r-${row.id}`} flexDirection="row" paddingLeft={1}>
              <Text> </Text>
              <Text bold color={row.label.trim() ? 'text' : undefined}>{row.label ? ` ${row.label}` : ' '}</Text>
            </Box>
          )
        }
        const steps = row.action === 'cycle' || row.action === 'toggle'
        const mark = row.action === 'expand' ? (state.open.includes(row.id) ? '▾' : '▸') : ''
        return (
          <Box key={`r-${row.id}`} flexDirection="row" columnGap={1} paddingLeft={1}>
            <Text bold={here} color={here ? accent : undefined}>{here ? glyph : ' '}</Text>
            <Text bold={here} color="text" dimColor={row.muted && !here} wrap="truncate-end">{row.label.padEnd(props.labelWidth)}</Text>
            {steps ? <Text color={accent}>‹</Text> : null}
            <Text bold={here} color={row.muted ? undefined : 'text'} dimColor={row.muted}>{row.value}</Text>
            {steps ? <Text color={accent}>›</Text> : null}
            {mark ? <Text color={accent}>{mark}</Text> : null}
            {row.note ? <Text dimColor wrap="truncate-end">{row.note}</Text> : null}
          </Box>
        )
      })}
      {lines.length > room ? <Text dimColor>{`  ${top + shown.length} of ${lines.length} · ↑↓ scroll`}</Text> : null}
    </Box>
  )
}

export default Menu
