import type { ClientModule } from 'claude-code'

// The mascot column: his floating words, the mascot in his shirt colour, and whatever reaction he is
// in the middle of. A click posts `{ tap: true }` and the hooks roll a reaction, handed back as `react`
// (a new `id` starts it): `shake` (a dizzy WHOOAH), `pacman`, `chef`, `storm`, or `spider` (one spins a web
// in the top-left corner and drops down on a thread while he looks up), or `night` (a scarf, a dark sky with a
// moon, twinkling stars and fireflies); the snake chase plays on the band. `climb` is a counter:
// each new value starts the ladder gag. During a storm, a click pops the umbrella early.
export type Reaction = { kind: 'shake' | 'pacman' | 'chef' | 'storm' | 'spider' | 'night'; id: number }
export type MascotProps = {
  pose: string[]
  bubble: string[]
  bubbleColor?: string
  color: string
  climb: number
  // When the last climb was asked for (ms). A mascot mounted fresh, after Slim, climbs if the request is recent.
  climbAt?: number
  rows: number
  leanPoses: string[][]
  dancePoses: string[][]
  react: Reaction | null
  ultra?: boolean // ultracode is on: he is the purple sparkler mascot from the engine's own banner
  // A voice clip playing now: each new id starts it, and his head lifts off his body by frames[i] rows every stepMs.
  talk: { id: number; frames: readonly number[]; stepMs: number; startedAt?: number } | null
}
type MascotState = {
  seenClimb: number
  climbTick: number
  climbing: boolean
  seenReact: number
  tick: number
  reacting: Reaction['kind'] | null
  umbrellaAt: number
  seenTalk: number
  talkTick: number
  talking: boolean
  talkStartedAt: number
}

const latestBySurface = new WeakMap<object, MascotProps>()
const TICK_MS = 140
const PINK = '#ff5fa2'
const ULTRA = '#a78bfa' // the banner mascot's purple while ultracode is on
const SPLASH = ['·', '✢', '✳', '✶', '✻', '✽'] // the menus' spinner frames, as rain splashing on the umbrella
const SPARK = '#e8c547' // the sparkler's gold
// The ladder needs room above him; a climb asked for in the last few seconds plays on a fresh mount too.
const ladderEnd = (room: number): number => {
  const TOP = Math.max(1, room - 1)
  return 3 + TOP * 2 + 2 + 4 + TOP * 2 + 3 + 1
}
const fresh = (p: MascotProps): MascotState => ({ seenClimb: p.climb, climbTick: 0, climbing: Math.max(0, p.rows - p.pose.length) >= 3 && (p.climbAt ?? 0) > 0 && Date.now() - (p.climbAt ?? 0) < 3000, seenReact: p.react?.id ?? 0, tick: 0, reacting: null, umbrellaAt: -1, seenTalk: p.talk?.id ?? 0, talkTick: 0, talking: false, talkStartedAt: 0 })
const REACT_TICKS: Record<Reaction['kind'], number> = { shake: 18, pacman: 26, chef: 30, storm: 96, spider: 70, night: 80 }

const Mascot: ClientModule<MascotProps, MascotState> = (props, surface) => {
  const { Box, Text } = surface.elements
  latestBySurface.set(surface, props)
  const state = surface.state ?? fresh(props)
  const rows = props.rows
  const roomAbove = Math.max(0, rows - props.pose.length) // rows free above him at rest

  // Ladder gag timeline, in ticks.
  const H = roomAbove
  const APPEAR = 3
  const TOP = Math.max(1, H - 1)
  const CLIMB = APPEAR + TOP * 2
  const HOLD = CLIMB + 2
  const GONE = HOLD + 4
  const FLOAT = GONE + TOP * 2
  const LAND = FLOAT + 3
  const END = LAND + 1

  if (surface.state === undefined) {
    surface.setState(fresh(props))
    surface.every(TICK_MS, () => {
      const s = surface.state ?? fresh(props)
      const p = latestBySurface.get(surface) ?? props
      let n = { ...s }
      // Start a ladder when a new climb arrives and nothing else is playing.
      // The room comes from the latest props, not the first render's, so a Bulk after Slim gets the full height.
      const room = Math.max(0, p.rows - p.pose.length)
      if (p.climb !== s.seenClimb) {
        n = { ...n, seenClimb: p.climb, climbTick: 0, climbing: room >= 3 && !s.reacting }
      } else if (s.climbing) {
        const t = s.climbTick + 1
        n = { ...n, climbTick: t, climbing: t < ladderEnd(room) }
      }
      // Start a reaction when a new one arrives and nothing is playing; one in progress always plays out.
      const id = p.react?.id ?? 0
      if (s.reacting) {
        const t = s.tick + 1
        const still = t < REACT_TICKS[s.reacting]
        n = { ...n, tick: t, reacting: still ? s.reacting : null }
        if (!still) surface.post({ done: true })
      } else if (id !== s.seenReact) {
        n = { ...n, seenReact: id, tick: 0, reacting: !n.climbing && p.react ? p.react.kind : null, umbrellaAt: -1 }
        if (!n.reacting) surface.post({ done: true })
      }
      surface.setState(n)
    })
    // The mouth follows the clip by elapsed time, not by ticks, so a timer running late never lets it drift.
    surface.every(50, () => {
      const s = surface.state ?? fresh(props)
      const p = latestBySurface.get(surface) ?? props
      const id = p.talk?.id ?? 0
      if (s.talking && p.talk) {
        const t = Math.floor((Date.now() - s.talkStartedAt) / p.talk.stepMs)
        const still = t < p.talk.frames.length
        if (t !== s.talkTick || !still) surface.setState({ ...s, talkTick: t, talking: still })
        if (!still) surface.post({ talked: true })
      } else if (id !== s.seenTalk) {
        surface.setState({ ...s, seenTalk: id, talkTick: 0, talking: id !== 0 && !s.reacting && !s.climbing, talkStartedAt: p.talk?.startedAt ?? Date.now() })
      }
    })
    surface.onPointer(event => {
      if (event.type !== 'down') return
      const s = surface.state ?? fresh(props)
      // In the rain, a click pops the umbrella; otherwise the hooks roll a reaction.
      if (s.reacting === 'storm' && s.tick >= 12 && s.umbrellaAt < 0) {
        surface.setState({ ...s, umbrellaAt: s.tick })
        return
      }
      surface.post({ tap: true })
    })
  }

  const pad = (s: string) => {
    const gap = Math.max(0, surface.columns - s.length)
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + s + ' '.repeat(gap - left)
  }
  const nudge = (l: string, dir: number) => (dir === 0 ? l : dir < 0 ? `${l.slice(1)} ` : ` ${l}`.slice(0, l.length))

  // ---- the ladder gag: where he stands and what shows
  let lift = 0
  let ladder = false
  let startled = false
  let chute: 'open' | 'crumpled' | null = null
  let sway = 0
  let pose = props.pose
  if (state.climbing) {
    const t = state.climbTick
    if (t < APPEAR) ladder = true
    else if (t < CLIMB) {
      ladder = true
      lift = Math.min(TOP, Math.floor((t - APPEAR) / 2) + 1)
      const step = Math.floor((t - APPEAR) / 2)
      const lean = props.leanPoses[step % Math.max(1, props.leanPoses.length)] ?? props.pose
      pose = lean.map(l => nudge(l, step % 2 === 0 ? 1 : -1))
    } else if (t < HOLD) {
      ladder = true
      lift = TOP
    } else if (t < GONE) {
      lift = TOP
      startled = true
    } else if (t < FLOAT) {
      chute = 'open'
      lift = Math.max(0, TOP - Math.floor((t - GONE) / 2) - 1)
      sway = Math.floor((t - GONE) / 2) % 2 === 0 ? -1 : 1
    } else if (t < LAND) chute = 'crumpled'
  }
  if (sway !== 0) pose = pose.map(l => nudge(l, sway))

  // A row of cells with a colour each, as runs of one colour.
  const runsOf = (chars: string[], cols: string[], dims?: boolean[]): { t: string; c: string; d?: boolean }[] => {
    const out: { t: string; c: string; d?: boolean }[] = []
    chars.forEach((ch, x) => {
      const c = cols[x] ?? 'text'
      const d = dims?.[x] ?? false
      const last = out[out.length - 1]
      if (last && last.c === c && (last.d ?? false) === d) last.t += ch
      else out.push({ t: ch, c, d })
    })
    return out
  }
  // ---- reactions: lines drawn above him, and his own pose while it plays
  type Line = { t: string; c?: string; d?: boolean; b?: boolean; segs?: { t: string; c: string; d?: boolean }[] }
  let overhead: Line[] = []
  let poseColors: (string | undefined)[] = [undefined, undefined, undefined] // per row; undefined = usual
  let words: Line | null = null
  const k = state.tick
  if (state.reacting === 'shake') {
    // Shaken, not tickled: a fast run through the poses, a column each way, and a dizzy WHOOAH.
    pose = (props.dancePoses[k % Math.max(1, props.dancePoses.length)] ?? pose).map(l => nudge(l, k % 2 === 0 ? 1 : -1))
    words = { t: k < 12 ? 'WHOOAH' : '@_@', c: 'text', b: true }
  } else if (state.reacting === 'pacman') {
    // He turns into a pacman and chomps.
    const open = k % 2 === 0
    pose = open ? ['▗▟█████▙▖', '▐█████▀▘ ', '▝▜█████▛▘'] : ['▗▟█████▙▖', '▐███████▌', '▝▜█████▛▘']
    poseColors = ['warning', 'warning', 'warning']
  } else if (state.reacting === 'chef') {
    // A chef's hat, and three ingredients tossed up and caught in turn: a red tomato, a green pepper, a die.
    const hatRows: Line[] = [{ t: '▗▄▄▄▄▄▖', c: 'text' }, { t: '▐█████▌', c: 'text' }, { t: ' ▀▀▀▀▀ ', c: 'text', d: true }]
    const items: { ch: string; c: string; x: number; phase: number }[] = [
      { ch: '●', c: 'error', x: 2, phase: 0 },
      { ch: '▲', c: 'success', x: 5, phase: 3 },
      { ch: '⚄', c: 'text', x: 8, phase: 6 },
    ]
    const flight = Math.max(1, Math.min(4, roomAbove - hatRows.length))
    const sky: string[][] = Array.from({ length: flight }, () => Array.from({ length: 11 }, () => ' '))
    const skyColors: string[][] = Array.from({ length: flight }, () => Array.from({ length: 11 }, () => 'text'))
    for (const it of items) {
      const u = (k + it.phase) % 9 // 0..8: up 4, down 4
      const height = u <= 4 ? u : 8 - u
      const y = flight - 1 - Math.min(flight - 1, height)
      if (u === 0) continue // in the hand
      const row = sky[y]
      if (row) {
        row[it.x] = it.ch
        skyColors[y]![it.x] = it.c
      }
    }
    overhead = [...sky.map((row, i) => ({ t: row.join(''), c: skyColors[i]!.find(c => c !== 'text') ?? 'text' })), ...hatRows]
  } else if (state.reacting === 'spider') {
    // A web is spun stroke by stroke in the top-left corner, then the spider, the spinner glyph, drops
    // on a thin thread to just above his head, dangles, and climbs back up. He looks up the whole time.
    const SPIN = ['·', '✢', '✳', '✶', '✻', '✽']
    const W = 11
    const blank = () => Array.from({ length: W }, () => ' ')
    const grid: string[][] = Array.from({ length: Math.max(0, roomAbove) }, blank)
    const colors: string[][] = Array.from({ length: Math.max(0, roomAbove) }, () => Array.from({ length: W }, () => 'inactive'))
    const put = (x: number, y: number, ch: string, c = 'inactive') => {
      if (y >= 0 && y < grid.length && x >= 0 && x < W) {
        grid[y]![x] = ch
        colors[y]![x] = c
      }
    }
    // The web: nine strokes around a hub at (1, 1), one stroke a tick.
    const strokes: [number, number, string][] = [[1, 1, '┼'], [0, 0, '╲'], [2, 0, '╱'], [0, 1, '─'], [2, 1, '─'], [1, 0, '│'], [0, 2, '╱'], [2, 2, '╲'], [1, 2, '│']]
    const SPIN_END = strokes.length
    const dropRows = Math.max(1, roomAbove - 2) // from under the hub to just above his head
    const DROP_END = SPIN_END + dropRows * 2
    const DANGLE_END = DROP_END + 10
    const CLIMB_END = DANGLE_END + dropRows * 2
    const fade = k >= CLIMB_END
    const drawn = Math.min(strokes.length, k + 1)
    if (!fade) for (const [x, y, ch] of strokes.slice(0, drawn)) put(x, y, ch)
    let spiderRow = -1
    if (k >= SPIN_END && k < DROP_END) spiderRow = 1 + Math.floor((k - SPIN_END) / 2) + 1
    else if (k >= DROP_END && k < DANGLE_END) spiderRow = 1 + dropRows - ((k - DROP_END) % 6 >= 3 ? 1 : 0)
    else if (k >= DANGLE_END && k < CLIMB_END) spiderRow = 1 + dropRows - Math.floor((k - DANGLE_END) / 2) - 1
    if (spiderRow >= 2) {
      for (let r = 2; r < spiderRow; r += 1) put(1, r, '│')
      put(1, spiderRow, SPIN[k % SPIN.length] ?? '·', 'text')
    }
    overhead = grid.map((row, i) => ({ t: row.join(''), c: colors[i]!.includes('text') ? undefined : 'inactive' }))
    // Per-cell colour is not available on a line, so the spider's row is drawn in the plain text colour.
    overhead = overhead.map((line, i) => (colors[i]!.includes('text') ? { ...line, c: 'text' } : line))
    // Looking up while the web is spun and the spider comes down; once it reaches the bottom his look
    // returns to normal.
    const still = props.dancePoses[0] ?? props.pose
    pose = k < DROP_END ? still.map((l, i) => (i === 0 ? l.replace('▛', '▄').replace('▜', '▄') : l)) : still
  } else if (state.reacting === 'night') {
    // Night falls: a thin scarf, a moon in the top-left corner, stars twinkling across the sky, and three
    // fireflies drifting about as pulsing dots.
    const W = 11
    const rows = Math.max(0, roomAbove)
    const chars: string[][] = Array.from({ length: rows }, () => Array.from({ length: W }, () => ' '))
    const cols: string[][] = Array.from({ length: rows }, () => Array.from({ length: W }, () => 'text'))
    const dims: boolean[][] = Array.from({ length: rows }, () => Array.from({ length: W }, () => false))
    const dusk = Math.min(1, k / 8) // the sky fills in over the first beats
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const seed = (x * 13 + y * 7) % 17
        // Stars come out a few at a time as dusk falls, each in a fixed place.
        if (seed < 4 && dusk >= (seed + 1) / 4) {
          // Each star keeps its own twinkle rhythm.
          const twinkle = (k + seed * 3) % 9
          chars[y]![x] = twinkle < 2 ? '✦' : twinkle < 5 ? '·' : ' '
          cols[y]![x] = 'text'
          dims[y]![x] = twinkle >= 2
        }
      }
    }
    if (rows > 0 && dusk >= 0.5) {
      chars[0]![1] = '☾'
      cols[0]![1] = 'text'
      dims[0]![1] = false
    }
    // Fireflies wander on slow loops and pulse through the spinner frames.
    const SPINF = ['·', '✢', '✳', '✶', '✻', '✽']
    const flies = [
      { phase: 0, cx: 5, cy: Math.max(1, rows - 2) },
      { phase: 2.1, cx: 8, cy: Math.max(1, Math.floor(rows / 2)) },
      { phase: 4.2, cx: 3, cy: Math.max(1, rows - 3) },
    ]
    if (rows > 1 && k >= 6) {
      flies.forEach((f, i) => {
        const x = Math.round(f.cx + 2.5 * Math.sin(k / 6 + f.phase))
        const y = Math.round(f.cy + 1.2 * Math.cos(k / 9 + f.phase))
        if (y >= 0 && y < rows && x >= 0 && x < W) {
          chars[y]![x] = SPINF[(k + i * 2) % SPINF.length] ?? '·'
          cols[y]![x] = i === 1 ? 'success' : 'warning'
          dims[y]![x] = false
        }
      })
    }
    overhead = chars.map((row, y) => ({ t: row.join(''), segs: runsOf(row, cols[y]!, dims[y]!) }))
    // The scarf: a thin knitted row between head and body, with a tail off to one side.
    const still = props.dancePoses[0] ?? props.pose
    pose = [still[0] ?? '', ' ≈≈≈≈≈≈≈▖', still[1] ?? '', still[2] ?? '']
    poseColors = ['claude', 'error', undefined, 'claude']
  } else if (state.reacting === 'storm') {
    // A white cloud darkens to grey, then rains blue drops on him; later, or on a click, an umbrella
    // opens over his head and the drops bounce off to the sides.
    const grey = k >= 8
    const raining = k >= 12
    // The umbrella always comes out: a dozen ticks into the rain, or at once on a click.
    const umbrellaAt = state.umbrellaAt >= 0 ? state.umbrellaAt : 30
    const umbrella = k >= umbrellaAt
    // He glances up at the sky for a few beats before the umbrella comes out, then looks down again.
    const lookingUp = k >= umbrellaAt - 4 && k < umbrellaAt
    // A blank row above the cloud keeps it a little lower in the column.
    const cloud: Line[] = [{ t: ' ' }, { t: ' ▗▄▄▟▙▄▖ ', c: grey ? 'inactive' : 'text' }, { t: '▐███████▌', c: grey ? 'inactive' : 'text' }]
    const brollyRows = umbrella ? 2 : 0
    const rainRows = Math.max(1, roomAbove - cloud.length - brollyRows)
    // Rain falls across the whole width down to the umbrella. On the row just above the canopy, a few
    // white dots flicker where drops splash on it.
    const rain: Line[] = Array.from({ length: rainRows }, (_, r) => {
      if (!raining) return { t: ' ' }
      const lastRow = r === rainRows - 1
      const cells = Array.from({ length: 11 }, (_, x) => {
        if (umbrella && lastRow && (x * 3 + k) % 5 === 0 && x > 0 && x < 10) return SPLASH[(x + k) % SPLASH.length] ?? '·'
        const falling = (x * 7 + r * 3 + k) % 4 === 0
        return falling ? '╎' : ' '
      })
      const splashy = umbrella && lastRow && cells.some(ch => SPLASH.includes(ch))
      if (!splashy) return { t: cells.join(''), c: 'ide' }
      return { t: cells.join(''), segs: runsOf(cells, cells.map(ch => (SPLASH.includes(ch) ? 'text' : 'ide'))) }
    })
    const brolly: Line[] = umbrella ? [{ t: '▗▄▟█████▙▄▖', c: 'error' }, { t: '     ┃     ', c: 'text' }] : []
    const stack = [...cloud, ...rain, ...brolly]
    overhead = stack.length > roomAbove ? stack.slice(stack.length - roomAbove) : stack
    // He stands dead still in the weather, looking up just before the umbrella.
    const still = props.dancePoses[0] ?? props.pose
    pose = lookingUp ? still.map((l, i) => (i === 0 ? l.replace('▛', '▄').replace('▜', '▄') : l)) : still
  }

  // ---- talking: his head lifts one row off his body while the voice is loud enough, an empty gap between
  let mouthRows = 0
  if (state.talking && props.talk) {
    const still = props.dancePoses[0] ?? props.pose
    mouthRows = rows > still.length && (props.talk.frames[state.talkTick] ?? 0) > 0 ? 1 : 0
    pose = still
  }

  // ---- the parachute canopy sized to the room above him
  const roomNow = Math.max(0, rows - props.pose.length - lift)
  const canopyRows = chute === 'open' ? Math.max(1, Math.min(4, roomNow)) : 0
  const CANOPY = [' ▄▟█████▙▄ ', '▐█▓▒░▒▓█▌', ' ╲ ╲ │ ╱ ╱ ', '  ╲ ╲│╱ ╱  ']
  const CANOPY_COLORS = ['error', 'text', 'text', 'text']
  const canopy = CANOPY.slice(4 - canopyRows)
  const canopyColors = CANOPY_COLORS.slice(4 - canopyRows)
  if (startled && roomNow < 1) startled = false

  // Only the idle mascot wears ultracode's purple and sparkler; reactions and the ladder use his usual colours.
  const ultraIdle = props.ultra === true && !state.reacting && !state.climbing && !state.talking
  // ---- what sits above him this frame, newest reason first
  const bubbleLines: Line[] = words ? [words, { t: ' ' }] : props.bubble.map(l => ({ t: l, c: props.bubbleColor ?? 'text', b: true }))
  const aboveLines: Line[] = chute === 'open'
    ? canopy.map((t, i) => ({ t, c: canopyColors[i], d: i >= canopy.length - 2 && canopy.length > 2 }))
    : chute === 'crumpled'
      ? [{ t: '▁▂▃▂▁▂▃▂▁', c: 'error', d: true }]
      : overhead.length > 0
        ? overhead.slice(-roomAbove)
        : bubbleLines
  const stackAbove = aboveLines.length + (startled ? 1 : 0)
  // Filler rows are emitted only while the ladder plays, so at rest the column takes the row's height.
  const above = state.climbing ? Math.max(0, rows - stackAbove - props.pose.length - lift) : 0
  const below = lift
  const belowStart = above + stackAbove + props.pose.length
  const rung = (row: number) => (row % 2 === 0 ? '┣━┫' : '┃ ┃')
  return (
    <Box flexDirection="column" justifyContent="flex-end" width="100%" height="100%">
      {Array.from({ length: above }, (_, i) => (
        <Text key={`a${i}`} color="claude" dimColor>{pad(ladder ? rung(i) : ' ')}</Text>
      ))}
      {startled ? <Text color="error" bold>{pad('!')}</Text> : null}
      {aboveLines.map((line, i) =>
        line.segs ? (
          <Box key={`o${i}`} flexDirection="row">
            {line.segs.map((sg, j) => <Text key={`o${i}-${j}`} color={sg.c} dimColor={sg.d}>{sg.t}</Text>)}
          </Box>
        ) : (
          <Text key={`o${i}`} color={line.c} dimColor={line.d} bold={line.b}>{pad(line.t)}</Text>
        ),
      )}
      {pose.map((line, i) =>
        i === 1 && mouthRows > 0 ? (
          <Box key={`m${i}`} flexDirection="column">
            {Array.from({ length: mouthRows }, (_, j) => (
              <Text key={`mouth${j}`}>{pad('')}</Text>
            ))}
            <Text color={poseColors[i] ?? (i === pose.length - 2 ? props.color : 'claude')}>{pad(line)}</Text>
          </Box>
        ) : i === 0 && ultraIdle ? (
          // The head stays where it is; the gold sparkler sits in the two cells after it.
          <Box key={`m${i}`} flexDirection="row">
            <Text color={ULTRA}>{pad(line).slice(0, pad(line).length - 2)}</Text>
            <Text color={SPARK}>/✦</Text>
          </Box>
        ) : (
          <Text key={`m${i}`} color={poseColors[i] ?? (ultraIdle ? ULTRA : i === pose.length - 2 ? props.color : 'claude')} bold={state.reacting === 'shake'}>{pad(line)}</Text>
        ),
      )}
      {Array.from({ length: below }, (_, i) => (
        <Text key={`u${i}`} color="claude" dimColor>{pad(ladder ? rung(belowStart + i) : ' ')}</Text>
      ))}
    </Box>
  )
}

export default Mascot
