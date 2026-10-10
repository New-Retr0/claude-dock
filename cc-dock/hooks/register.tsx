import type { MenuRow, Seg } from './menu'
import { VOICE_FRAMES, VOICE_STEP_MS } from './voice-envelope'
import type { Elements, EngineInterface, Register, ModelEffort, SessionContextUsage, SessionCost, SessionRateLimit, SessionContextBreakdown, ConfigRow } from 'claude-code'

type Shell = {
  toolUseId: string
  description: string
  command: string
  startedAt: number
  taskId?: string
  agentId?: string
  endedAt?: number
  failed?: boolean
}
const LINGER_MS = 20_000
type Limit = { kind: string; label: string; percent: number; resetsAt?: string; dollars?: { used: number; limit: number } }
type Plan = { tier: string; limits: Limit[]; codeShare?: number; fetchedAt: number }

// Module state resets on reload; the next measurement, fetch and tool call refill it.
let context: SessionContextUsage | null = null
let rateLimits: SessionRateLimit[] = []
// True when the last response's own rate limits are newer than the usage endpoint's reading.
let rateLimitsFresh = false
let cost: SessionCost | undefined
let plan: Plan | null = null
let planError = ''
let frame = 0
let tasksDir = ''
const expanded = new Set<string>()
let view: 'dash' | 'shells' | 'context' | 'fast' = 'dash'
let planOpen = true
let slim = false // the ultra-compact band: the mascot and the buttons, nothing else
// The dock's own look, chosen on the Dock tab and kept in the store.
const COLORS: readonly { id: string; name: string }[] = [
  { id: 'claude', name: 'orange' }, { id: 'warning', name: 'yellow' }, { id: 'success', name: 'green' }, { id: 'ide', name: 'blue' },
  { id: 'permission', name: 'lavender' }, { id: '#827dbd', name: 'purple' }, { id: 'error', name: 'red' }, { id: 'text', name: 'white' }, { id: 'inactive', name: 'grey' },
]
const RULE_STYLES: readonly { id: string; name: string }[] = [
  { id: '─', name: 'thin' }, { id: '━', name: 'thick' }, { id: '═', name: 'double' }, { id: '-', name: 'dashes' }, { id: '=', name: 'equals' }, { id: '+', name: 'plus' }, { id: '·', name: 'dots' }, { id: '╌', name: 'broken' },
]
// Writes a setting in the background, so the change is drawn at once and a failed write is ignored.
const save = ($: EngineInterface, key: string, value: unknown): void => {
  void Promise.resolve()
    .then(() => $.store.set(key, value as never))
    .catch(() => {
      // remembered for this session only
    })
}
type DockLook = { ruleColor: number; ruleAltColor: number; ruleStyle: number; ruleShimmer: boolean; rulePattern: boolean; uiColor: number; avatar: boolean; header: boolean }
let look: DockLook = { ruleColor: 0, ruleAltColor: 0, ruleStyle: 0, ruleShimmer: false, rulePattern: false, uiColor: 0, avatar: true, header: true }
let ruleFrame = 0
const colorOf = (i: number) => COLORS[i]?.id ?? 'text'
let chatOpen = true
let usageNote = ''
// True while a compaction runs; the avatar's bubble shows it, with dots that move.
let compacting = false
// The 90% question is asked once per crossing of the line.
let compactAsked = false
let breakdown: SessionContextBreakdown | null = null
let breakdownNote = ''
let breakdownBusy = false
let bandColumns = 0 // the band's width as last drawn, for recounting the breakdown without a click
let compactNote = '' // why a compaction did not run, beside the buttons
let compactArmedAt = 0 // the Compact button asks "Yes?" until this plus CONFIRM_MS
// The session's permission mode, read from the footer line the engine draws under the prompt
// (`⏵⏵ bypass permissions on (shift+tab to cycle)`), so Shift+Tab changes show up too.
let permissionMode = ''
const MODE_WORDS: readonly [RegExp, string][] = [
  [/bypass permissions on/i, 'bypass'],
  [/manual mode on/i, 'manual'],
  [/accept edits on/i, 'accept edits'],
  [/plan mode on/i, 'plan'],
  [/auto mode on/i, 'auto'],
  [/don'?t ask on/i, "don't ask"],
]
const CONFIRM_MS = 6_000
let compactions = 0
// Bypass: the button shows only when Settings → Dock → PERMISSIONS turns it on, which is off by default.
let showBypass = false
// MCP servers the model may not call, switched off in the MCP pane.
let bypassArmedAt = 0 // the Bypass button asks "Yes?" until this plus CONFIRM_MS
let bypassWanted = false // confirmed: the next permission prompt switches this session to bypass
let bypassNote = ''
let compactWhenIdle = false // Compact pressed mid-turn: runs the moment the turn ends, no prompt queued
let model = ''
let effort = ''
let fastMode = false
let ultracode = false // the session's ultracode mode, as /effort last reported it
let ultraPending: 'on' | 'off' | '' = '' // a switch to hand /effort once idle
let fastNote = ''
// The mascot's speech bubble: who it is talking to and what it is saying right now.
let userName = ''
let bubble = ''
const QUIPS = {
  hello: ['Hi {name}!', 'Yo {name}.', '{name}!', 'Hey.'],
  thinking: ['Hmm.', 'On it.', 'Brb.', 'Shh.'],
  done: ['Done.', 'Ta-da.', 'Easy.', 'Next?'],
  idle: ['Boop.', 'Tea?', 'Psst.', 'Hi.', 'Zzz.', 'Nice.'],
  compact: ['Tidy.', 'Roomy.'],
  fast: ['Zoom.', 'Whee.'],
  full: ['Full-ish.'],
}
let fastQuipDue = false
// A burst of clicks on the mascot rolls a reaction: a dizzy shake, pacman, a chef's hat, a storm, a spider
// dropping from a web, a starry night with fireflies, or the snake chase on the band. The
// shirt colour is chosen on the Dock tab and remembered across sessions.
const SHIRTS = ['claude', 'warning', 'success', 'ide', 'permission', '#827dbd', 'error', 'text']

// Notification sounds, files in sounds/: one choice per moment by id, '' meaning off, kept in the store.
// Chime, Glass, Confirm, Question, Rise, Drop and Pluck are Kenney's CC0 Interface Sounds (KENNEY-LICENSE.txt).
const SOUNDS = [
  { id: 'success', name: 'Success' },
  { id: 'ping', name: 'Ping' },
  { id: 'bubble', name: 'Bubble' },
  { id: 'chime', name: 'Chime' },
  { id: 'glass', name: 'Glass' },
  { id: 'confirm', name: 'Confirm' },
  { id: 'question', name: 'Question' },
  { id: 'rise', name: 'Rise' },
  { id: 'drop', name: 'Drop' },
  { id: 'pluck', name: 'Pluck' },
] as const
const VOLUMES = [0.25, 0.5, 0.75, 1] as const
type SoundMoment = 'done' | 'needs' | 'agent'
// `notify` mutes every chime at once; `voice` is the idle chatter.
type SoundPrefs = Record<SoundMoment, string> & { volume: number; notify: boolean; voice: boolean }
let sounds: SoundPrefs = { done: 'success', needs: 'ping', agent: '', volume: 1, notify: true, voice: true }

// Commands that never finish on their own. With autoBackground on, the dock runs them in the background so the
// main agent stays free to answer; anything else runs as Claude asked.
const NEVER_ENDS: readonly RegExp[] = [
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/,
  /\b(next|nuxt|astro|remix|vite)\s+dev\b/,
  /\bnodemon\b/,
  /--watch\b/,
  /\btsc\b.*\s-w\b/,
  /\btail\s+-[a-zA-Z]*f/,
  /\bpython3?\s+-m\s+http\.server\b/,
  /\b(uvicorn|gunicorn)\b|\bflask\s+run\b|\brails\s+s(erver)?\b|\bartisan\s+serve\b/,
  /\bdocker[-\s]compose\s+up\b(?![^|;&]*\s-d\b)/,
]
const neverEnds = (command: string): boolean => NEVER_ENDS.some(re => re.test(command))
let autoBackground = false

// Idle chatter: after fifteen quiet minutes, and every fifteen minutes of quiet after that, one roll at one
// in four. A win makes him talk in every open dock, his head lifting in step with the clip; only the dock that
// rolled it plays the clip.
const IDLE_VOICE_MS = 15 * 60_000
const ACTIVE_WRITE_MS = 60_000 // how often a dock records that it is busy or in use, for the others to read
const SPEECH_LIVE_MS = 15_000 // a speech this recent is still shown by a dock that has not yet shown it
const VOICE_STORE_KEY = 'chatter'
// Tells this dock's roll apart from another dock's that landed on the same window.
const voiceToken = String(Math.random())
// Shared by every dock of this user: when anything was last active, the last roll, and the last speech.
type Chatter = { active?: number; roll?: { window: number; by: string }; spokeAt?: number }
// When a turn last showed life, a model request or the footer saying it works; a turn silent for a long time is over.
let lastStepAt = 0
let talk: { id: number; frames: readonly number[]; stepMs: number; startedAt?: number } | null = null
// A reaction or clip the mascot never played (he was not drawn) is dropped after this, or it would block every later one.
const REACT_MAX_MS = 15_000
const TALK_MAX_MS = VOICE_FRAMES.length * VOICE_STEP_MS + 1_000
let reactSeen = { id: 0, at: 0 } // when the 700 ms tick first saw the current reaction
let talkId = 0
let lastActivityAt = 0
let lastActiveWrite = 0
let lastShownSpeech = 0

async function readChatter($: EngineInterface): Promise<Chatter> {
  const value = await $.store.get(VOICE_STORE_KEY).catch(() => undefined)
  return value && typeof value === 'object' ? (value as Chatter) : {}
}

async function writeChatter($: EngineInterface, patch: Chatter): Promise<void> {
  const current = await readChatter($)
  await $.store.set(VOICE_STORE_KEY, { ...current, ...patch }).catch(() => {})
}

// Starts his talk. Only the dock that rolled it plays the clip; `startedAt` is shared, so every mouth moves in step.
function startChatter($: EngineInterface, startedAt: number, speak: boolean): void {
  if (talk) return
  talkId += 1
  talk = { id: talkId, frames: VOICE_FRAMES, stepMs: VOICE_STEP_MS, startedAt }
  if (speak) {
    // The clip is far quieter than the chimes already; it plays a touch under their volume setting.
    const gain = Math.min(1, (VOLUMES[sounds.volume] ?? 0.5) * 0.9)
    void $.audio.play({ asset: 'sounds/idle-voice.mp3' }, { gain }).catch(() => {})
  }
  redraw($)
}

// Speaks in this dock and records it, so the other docs start their mouths at the same moment.
async function speakNow($: EngineInterface): Promise<void> {
  if (talk) return
  const now = await $.clock.now()
  lastShownSpeech = now
  await writeChatter($, { spokeAt: now })
  startChatter($, now, true)
}

async function noteActivity($: EngineInterface): Promise<void> {
  lastActivityAt = await $.clock.now()
  if (lastActivityAt - lastActiveWrite >= ACTIVE_WRITE_MS) {
    lastActiveWrite = lastActivityAt
    await writeChatter($, { active: lastActivityAt })
  }
}

// A fixed hash of the window's start: every dock reads the same coin for a window, heads one window in four.
function windowCoinHeads(windowAt: number): boolean {
  let x = (Math.floor(windowAt / 1000) ^ 0x9e3779b9) | 0
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b)
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296 < 0.25
}

// Once a second: shows another dock's speech, records that this dock is busy, and at each fifteen-minute window
// of quiet rolls to speak. The roll is claimed in the shared store first, so each window is rolled once.
async function chatterTick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (turnRunning && now - lastActiveWrite >= ACTIVE_WRITE_MS) {
    lastActiveWrite = now
    await writeChatter($, { active: now })
  }
  const shared = await readChatter($)
  if (shared.spokeAt && shared.spokeAt > lastShownSpeech && now - shared.spokeAt < SPEECH_LIVE_MS && look.avatar && !slim && !talk) {
    lastShownSpeech = shared.spokeAt
    startChatter($, shared.spokeAt, false)
  }
  if (!sounds.voice || turnRunning || !look.avatar || slim || talk) return
  const quietSince = Math.max(lastActivityAt, lastTurnEndAt, shared.active ?? 0)
  if (now - quietSince < IDLE_VOICE_MS) return
  const windowAt = quietSince + Math.floor((now - quietSince) / IDLE_VOICE_MS) * IDLE_VOICE_MS
  if ((shared.roll?.window ?? 0) >= windowAt) return
  await writeChatter($, { roll: { window: windowAt, by: voiceToken } })
  if ((await readChatter($)).roll?.by !== voiceToken) return
  if (windowCoinHeads(windowAt)) await speakNow($)
}

let lastChimeAt = 0
const soundName = (id: string): string => SOUNDS.find(x => x.id === id)?.name ?? 'off'
// Off, then each sound in order, wrapping both ways.
function stepSound(id: string, step: number): string {
  const order = ['', ...SOUNDS.map(x => x.id)]
  const at = Math.max(0, order.indexOf(id))
  return order[(at + step + order.length) % order.length] ?? ''
}

function playSound($: EngineInterface, id: string): void {
  const gain = VOLUMES[sounds.volume] ?? 0.5
  let played: Promise<unknown> | undefined
  switch (id) {
    case 'success': played = $.audio.play({ asset: 'sounds/success.mp3' }, { gain }); break
    case 'ping': played = $.audio.play({ asset: 'sounds/ping.mp3' }, { gain }); break
    case 'bubble': played = $.audio.play({ asset: 'sounds/bubble.mp3' }, { gain }); break
    case 'chime': played = $.audio.play({ asset: 'sounds/chime.mp3' }, { gain }); break
    case 'glass': played = $.audio.play({ asset: 'sounds/glass.mp3' }, { gain }); break
    case 'confirm': played = $.audio.play({ asset: 'sounds/confirm.mp3' }, { gain }); break
    case 'question': played = $.audio.play({ asset: 'sounds/question.mp3' }, { gain }); break
    case 'rise': played = $.audio.play({ asset: 'sounds/rise.mp3' }, { gain }); break
    case 'drop': played = $.audio.play({ asset: 'sounds/drop.mp3' }, { gain }); break
    case 'pluck': played = $.audio.play({ asset: 'sounds/pluck.mp3' }, { gain }); break
  }
  void played?.catch(() => {})
}

// A burst (a workflow's agents finishing together) chimes once.
async function chime($: EngineInterface, moment: SoundMoment): Promise<void> {
  const id = sounds[moment]
  if (!id || !sounds.notify) return
  const now = await $.clock.now()
  if (now - lastChimeAt < 1_200) return
  lastChimeAt = now
  playSound($, id)
}
let shirt = 0
type ReactionKind = 'shake' | 'pacman' | 'chef' | 'storm' | 'spider' | 'night'
let react: { kind: ReactionKind; id: number } | null = null
let reactId = 0
let taps: number[] = [] // recent clicks on the mascot; a burst of them rolls a reaction
const TAP_BURST = 4
const TAP_WINDOW_MS = 1_800
let lastTurnEndAt = 0
// A shuffle bag, the way games deal pieces: every item comes out once, in a random order, before any
// repeats, and the first of a fresh bag is never the last of the one before, so nothing plays twice in a row.
class Bag<T> {
  private left: T[] = []
  private last: T | undefined
  constructor(private readonly items: readonly T[]) {}
  draw(): T {
    if (this.left.length === 0) {
      const order = [...this.items]
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[order[i], order[j]] = [order[j]!, order[i]!]
      }
      if (order.length > 1 && order[0] === this.last) [order[0], order[order.length - 1]] = [order[order.length - 1]!, order[0]!]
      this.left = order
    }
    const pick = this.left.shift()!
    this.last = pick
    return pick
  }
}
type RollKind = ReactionKind | 'snake'
const reactionBag = new Bag<RollKind>(['shake', 'pacman', 'chef', 'storm', 'spider', 'night', 'snake'])
// One of the six reactions from the bag: five in the column, the snake chase on the band.
const rollReaction = (): void => {
  const kind = reactionBag.draw()
  if (kind === 'snake') scene = { t: 0 }
  else {
    reactId += 1
    react = { kind, id: reactId }
  }
}
let climb = 0 // bumped to send the mascot up the ladder
let climbAt = 0 // when it was last bumped, so a mascot remounted by Bulk still climbs
let lastQuipKind = ''
let bubbleSince = 0 // when the quip went up (clock ms)
let bubbleHold = 0 // how long it stays before it fades
// How often each kind of moment earns a word at all: rare, so a bubble is an easter egg.
const CHANCE: Record<keyof typeof QUIPS, number> = { hello: 1, thinking: 0.15, done: 0.2, idle: 0.2, compact: 0.6, fast: 0.8, full: 0.5 }
const HOLD: Record<keyof typeof QUIPS, number> = { hello: 6_000, thinking: 4_000, done: 4_000, idle: 4_000, compact: 4_000, fast: 4_000, full: 5_000 }
const quipBags = new Map<string, Bag<string>>()
// Maybe says something: by chance, the next line from that kind's shuffle bag, only when the bubble is empty.
const say = (kind: keyof typeof QUIPS, now: number): void => {
  if (slim || bubble || Math.random() > CHANCE[kind]) return
  let bag = quipBags.get(kind)
  if (!bag) {
    bag = new Bag(QUIPS[kind])
    quipBags.set(kind, bag)
  }
  const pick = bag.draw()
  bubble = pick.replace('{name}', userName || 'you')
  lastQuipKind = kind
  bubbleHold = HOLD[kind]
  bubbleSince = now
}
let fastReply = '' // what /fast last answered, shown on the Fast page
let effortOverride: ModelEffort | '' = '' // a level pressed on a chip, forced on each request only until /effort has run
const EFFORTS: readonly ModelEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EFFORT_COLOR: Record<ModelEffort, string> = { low: 'success', medium: 'ide', high: 'warning', xhigh: 'claude', max: 'error' }
let configNote = ''
let turnRunning = false
let spinnerWord = ''
const CONFIG_PANE = 'cc-dock-config'
// Client instances live on across reloads while their key holds, old module code and all; a key stamped
// per load makes every reload mount fresh ones.
const LOAD = Date.now().toString(36)
const MENU_ID = `config-menu-${LOAD}`
const ULTRA_ID = `ultracode-chip-${LOAD}`
const FAST_CHIP_ID = `fast-chip-${LOAD}`
const MASCOT_ID = `mascot-${LOAD}`
const shells = new Map<string, Shell>()

// The usage endpoint is rate limited: about once a minute at most, and after a 429 it waits as retry-after says.
const REFRESH_MS = 60_000 // idle poll
const AFTER_TURN_MS = 60_000 // a response just landed: refresh unless one did within this window
const BACKOFF_MIN_MS = 60_000
const BACKOFF_MAX_MS = 15 * 60_000
let tier = ''
let lastFetchAt = 0
let backoffUntil = 0
let backoffMs = 0
let fetching = false

const TIER_LABEL: Record<string, string> = {
  default_claude_max_20x: 'Max 20x',
  default_claude_max_5x: 'Max 5x',
  default_claude_pro: 'Pro',
}

// The mascot frames Claude Code itself ships (its front pose, then its turn-left and turn-right
// sprites), cycled so it looks side to side.
const DANCE: readonly (readonly string[])[] = [
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  [' ▐▛███▜█ ', '▝▜██████▀', ' ▝▝   ▝▝ '],
  ['  ▛██▛█▌ ', ' ▝█████▛ ', '  ▘▘  ▘▘ '],
  [' ▐▛███▜█ ', '▝▜██████▀', ' ▝▝   ▝▝ '],
  [' ▐▛███▜▌ ', '▝▜█████▛▘', '  ▘▘ ▝▝  '],
  [' ▐█▜██▛█ ', '▝▜██████▀', ' ▝▝   ▝▝ '],
  ['  █▛██▛▌ ', ' ▝█████▛ ', '  ▘▘  ▘▘ '],
  [' ▐█▜██▛█ ', '▝▜██████▀', ' ▝▝   ▝▝ '],
]

// The snake chase: a rare scene on the empty stage right of the sections. Act one, the mascot runs
// after a wriggling snake and gains on it; act two, it stops and opens an alien mouth far too big for
// its head; act three, the snake is gone in three gulps and the mascot looks pleased.
let scene: { t: number } | null = null
const MOUTH: readonly (readonly string[])[] = [
  [' ▐▛███▜▌ ', '▝▜▙▄▄▄▟▛▘', '  ▘▘ ▝▝  '],
  ['▐▛▀▀▀▀▀▜▌', '▐▌ᴠᴠᴠᴠᴠ▐▌', '▝▜▄▄▄▄▄▛▘'],
  ['▐▛▀▀▀▀▀▜▌', '▐▌ᴠᴠᴠᴠᴠ▐▌', '▝▜▄▄▄▄▄▛▘'],
]
const STAGE_H = 9
const PINK = '#ff5fa2'
// A coloured cell canvas: art is blitted at (x, y) with one colour per art row; spaces are transparent.
type Cell = { ch: string; c: string }
const canvas = (width: number): Cell[][] => Array.from({ length: STAGE_H }, () => Array.from({ length: width }, () => ({ ch: ' ', c: 'text' })))
const blit = (c: Cell[][], art: readonly string[], x: number, y: number, colors: string | readonly string[]): void => {
  art.forEach((row, i) => {
    const line = c[y + i]
    if (!line) return
    const color = typeof colors === 'string' ? colors : colors[i] ?? colors[colors.length - 1] ?? 'text'
    ;[...row].forEach((ch, j) => {
      const col = x + j
      if (ch !== ' ' && col >= 0 && col < line.length) line[col] = { ch, c: color }
    })
  })
}
// A row of cells as runs of one colour, for drawing.
const runs = (row: Cell[]): { t: string; c: string }[] => {
  const out: { t: string; c: string }[] = []
  for (const cell of row) {
    const last = out[out.length - 1]
    if (last && last.c === cell.c) last.t += cell.ch
    else out.push({ t: cell.ch, c: cell.c })
  }
  return out
}
const ULTRA = '#a78bfa' // the banner mascot's purple while ultracode is on (idle only)
const SPARK = '#e8c547' // the sparkler's gold
// The mascot's colours by row on the stage: head and legs orange, the shirt on the body.
const mascotColors = (shirtColor: string): string[] => ['claude', shirtColor, 'claude']
// The snake: two rows, a short skinny wave with an eye, two wriggle frames.
const SNAKE: readonly (readonly string[])[] = [
  ['▄▀▄   ▄▀▄   ▄▀▖', '   ▀▀▀   ▀▀▀   ◉▘'],
  ['   ▄▀▄   ▄▀▄ ▄▖', '▀▀▀   ▀▀▀   ▀  ◉▘'],
]
const SNAKE_W = 17

// A long zig-zag: the runner climbs and dives across the stage's rows, one row every two frames.
const zig = (t: number): number => {
  const span = STAGE_H - 4
  const k = Math.floor(t / 2) % (span * 2)
  return k <= span ? k : span * 2 - k
}
// The chase across the whole band: the mascot leaves its spot at the left edge and runs right; the snake,
// lower down, flees almost as fast, so the two travel a long way before the gap closes or the snake is
// cornered at the right edge. Then: stop, an arm reaches out and lifts the snake, the top of the head
// unscrews over a row of teeth, the snake goes down in bites, the head screws back, `gulp.`, a pink heart.
const snakeFrame = (t: number, width: number, shirtColor: string): { t: string; c: string }[][] | null => {
  const c = canvas(width)
  const SPEED = 2
  const FLEE = 1.85
  const snakeX = (f: number) => Math.min(width - SNAKE_W - 1, 18 + Math.floor(f * FLEE))
  let chaseFrames = 0
  while (chaseFrames * SPEED + 9 < snakeX(chaseFrames) && chaseFrames < 900) chaseFrames += 1
  const mc = mascotColors(shirtColor)
  const snakeY = 7
  if (t < chaseFrames) {
    blit(c, DANCE[t % 2 === 0 ? 0 : 1]!, t * SPEED, zig(t), mc)
    blit(c, SNAKE[t % 2]!, snakeX(t), snakeY - (Math.floor(t / 3) % 2), shirtColor)
    return c.map(runs)
  }
  const u = t - chaseFrames
  const sx = snakeX(chaseFrames)
  const mx = Math.max(1, sx - 9) // nose to tail
  const y = 4 // the head's row once he stops
  const body = DANCE[0]![1]!
  const legs = DANCE[0]![2]!
  const lower = () => blit(c, [body, legs], mx, y + 1, [shirtColor, 'claude'])
  const still = () => blit(c, DANCE[0]!, mx, y, mc)
  // The lid is the head, hinged at its back-left corner; it cracks, stands half open on a diagonal,
  // then swings right back and grows into a big block with teeth along its underside.
  const lidCrack = () => {
    blit(c, ['▗▟▌'], mx + 6, y - 1, 'claude')
    blit(c, [' ▐▛██▀▀ '], mx, y, 'claude')
  }
  const lidHalf = () => {
    blit(c, ['▗▟█▌'], mx + 5, y - 2, 'claude')
    blit(c, ['▗▟█▀'], mx + 3, y - 1, 'claude')
    blit(c, [' ▐▀▘'], mx, y, 'claude')
    blit(c, ['▐'], mx + 7, y, 'claude')
  }
  const lidOpen = () => {
    // A low lid: one row of head swung back, the open cavity beneath it.
    blit(c, ['▗▟█████▙▖'], mx - 1, y - 1, 'claude')
    blit(c, ['▌'], mx + 1, y, 'claude')
    blit(c, ['▐'], mx + 7, y, 'claude')
  }
  // The snake held at mouth level to the right of the head; `into` columns of it have gone in past the
  // right cheek, so only what is still outside is drawn.
  const held = (f: number, x: number, into: number) => {
    const art = SNAKE[f % 2]!.map(row => row.slice(into))
    blit(c, art, x, y - 1, shirtColor)
  }
  if (u < 2) {
    still()
    blit(c, SNAKE[0]!, sx, snakeY, shirtColor)
  } else if (u < 4) {
    // A short, thick arm out of the body.
    still()
    blit(c, [u === 2 ? '▆' : '▆▆'], mx + 9, y + 1, shirtColor)
    blit(c, SNAKE[u % 2]!, sx, snakeY, shirtColor)
  } else if (u < 8) {
    // Lifted straight up on the arm to mouth level, just right of the head.
    const lift = u - 4 // 0..3
    const sy = snakeY - lift
    still()
    blit(c, ['▆▆'], mx + 9, y + 1, shirtColor)
    for (let r = sy + 2; r <= y + 1; r += 1) blit(c, ['▐'], mx + 10, r, shirtColor)
    blit(c, SNAKE[u % 2]!, mx + 10, Math.max(0, sy), shirtColor)
  } else if (u === 8) {
    lower()
    lidCrack()
    blit(c, SNAKE[0]!, mx + 10, y - 1, shirtColor)
  } else if (u === 9) {
    lower()
    lidHalf()
    blit(c, SNAKE[1]!, mx + 10, y - 1, shirtColor)
  } else if (u < 16) {
    // Wide open; the snake slides in tail first, four columns a frame, and what passes the cheek is gone.
    lower()
    lidOpen()
    const into = (u - 10) * 4
    if (into < SNAKE_W) held(u, mx + 8, into)
  } else if (u === 16) {
    lower()
    lidHalf()
  } else if (u === 17) {
    lower()
    lidCrack()
  } else if (u < 22) {
    still()
    blit(c, ['gulp.'], mx + 2, y - 1, 'text')
  } else if (u < 30) {
    still()
    blit(c, ['♥'], mx + 4, y - 1, PINK)
  } else return null
  return c.map(runs)
}


const bar = (percent: number, width: number): string => {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
const barColor = (percent: number): 'error' | 'warning' | 'success' =>
  percent >= 90 ? 'error' : percent >= 70 ? 'warning' : 'success'

// The short zone name the system runs in (PDT, PST, CET), from the formatter's own parts.
const zoneName = (d: Date): string => {
  try {
    const part = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(d).find(x => x.type === 'timeZoneName')
    return part?.value ?? ''
  } catch {
    return ''
  }
}
const fmtTime = (d: Date): string => {
  const zone = zoneName(d)
  return `${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${zone ? ` ${zone}` : ''}`
}
const resetText = (iso: string | undefined, now: number): string => {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    const days = (d.getTime() - now) / 86_400_000
    if (days < 1 && d.getDate() === new Date(now).getDate()) return `resets ${fmtTime(d)}`
    if (days < 7) return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${fmtTime(d)}`
    return `expires ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
  } catch {
    return ''
  }
}
const kTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
const elapsed = (startedAt: number, now: number): string => {
  const s = Math.max(0, Math.round((now - startedAt) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

// "On track" the way the desktop usage page says it: used share vs. elapsed share of the weekly window.
// The per-model weeks come from the last usage reading; the engine's own windows name only the session and the week.
const currentLimits = (): Limit[] => {
  if (plan && !(rateLimitsFresh && rateLimits.length > 0)) return plan.limits
  const perModel = (plan?.limits ?? []).filter(l => l.kind === 'weekly_scoped')
  return rateLimits
    .map((w): Limit => ({
      kind: w.kind,
      label: w.kind === 'five_hour' ? 'Session' : w.kind === 'seven_day' ? 'Week' : w.kind,
      percent: w.percentUsed,
      resetsAt: w.resetsAt,
    }))
    .concat(perModel)
}

type ConfigTab = 'dock' | 'settings' | 'status' | 'config' | 'usage' | 'stats'
const CONFIG_TABS: readonly { id: ConfigTab; label: string }[] = [
  { id: 'dock', label: 'Dock' },
  { id: 'config', label: 'Config' },
  { id: 'status', label: 'Status' },
  { id: 'usage', label: 'Usage' },
  { id: 'stats', label: 'Stats' },
  { id: 'settings', label: 'File' },
]
let configTab: ConfigTab = 'dock'
let sessionStartedAt = 0

type Els = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
type BracketOpts = {
  key: string
  label: string
  color?: string // bracket colour when lit; dim when not
  lit?: boolean // default true
  width?: number // pad the label to this width, equally each side
  onPress: () => void
}
// The one button shape the dock draws: `[ label ]`, brackets coloured, the whole inside pressable.
// Padding rides inside the label as no-break spaces, which the Button keeps, so the click lands anywhere
// between the brackets.
const bracket = (els: Els, o: BracketOpts) => {
  const { Box, Text, Button } = els
  const lit = o.lit !== false
  const side = o.width ? Math.floor(Math.max(0, o.width - o.label.length) / 2) : 0
  const label = `\u00a0${'\u00a0'.repeat(side)}${o.label}${'\u00a0'.repeat(side)}\u00a0`
  return (
    <Box key={`${o.key}-wrap`} flexDirection="row" flexShrink={0}>
      <Text bold={lit} color={lit ? o.color ?? colorOf(look.uiColor) : undefined} dimColor={!lit}>[</Text>
      <Button key={o.key} label={label} plain dimColor={!lit} onPress={o.onPress} />
      <Text bold={lit} color={lit ? o.color ?? colorOf(look.uiColor) : undefined} dimColor={!lit}>]</Text>
    </Box>
  )
}

// ~/.claude/stats-cache.json: what the engine's own /stats screen draws from.
type StatsCache = {
  dailyActivity?: { date: string; messageCount: number; sessionCount: number; toolCallCount: number }[]
  dailyModelTokens?: { date: string; tokensByModel: Record<string, number> }[]
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }>
  totalSessions?: number
  totalMessages?: number
  longestSession?: { duration: number; timestamp: string }
  firstSessionDate?: string
}
type StatsPeriod = 'all' | '30' | '7'
let statsPeriod: StatsPeriod = 'all'
const PERIOD_LABEL: Record<StatsPeriod, string> = { all: 'All time', '30': 'Last 30 days', '7': 'Last 7 days' }

const bigNumber = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}b` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n)
const duration = (ms: number): string => {
  const m = Math.floor(ms / 60000)
  const d = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  return [d ? `${d}d` : '', hours ? `${hours}h` : '', `${m % 60}m`].filter(Boolean).join(' ')
}
const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

// The /stats overview as header lines: the year's activity grid, its legend, the period line and the figures.
const statsHeader = (cache: StatsCache, now: number, period: StatsPeriod, accent: string): Seg[][] => {
  const activity = cache.dailyActivity ?? []
  const byDay = new Map(activity.map(a => [a.date, a]))
  const cutoff = period === 'all' ? 0 : now - Number(period) * DAY_MS
  const inPeriod = (date: string) => new Date(`${date}T12:00:00Z`).getTime() >= cutoff
  const lines: Seg[][] = []

  // Grid: 53 week columns ending this week, rows Monday to Sunday, one cell per day.
  const today = new Date(now)
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const weekday = (new Date(todayUtc).getUTCDay() + 6) % 7 // Monday 0
  const thisMonday = todayUtc - weekday * DAY_MS
  const WEEKS = 53
  const firstMonday = thisMonday - (WEEKS - 1) * 7 * DAY_MS
  const counts = activity.map(a => a.messageCount).filter(n => n > 0).sort((a, b) => a - b)
  const q = (i: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * i))] ?? 0
  const level = (n: number) => (n <= 0 ? 0 : n <= q(0.25) ? 1 : n <= q(0.5) ? 2 : n <= q(0.75) ? 3 : 4)
  const GLYPH = ['·', '░', '▒', '▓', '█']
  const months: Seg[] = [{ t: '    ' }]
  let lastMonth = -1
  for (let w = 0; w < WEEKS; w += 1) {
    const monday = new Date(firstMonday + w * 7 * DAY_MS)
    const m = monday.getUTCMonth()
    if (m !== lastMonth && monday.getUTCDate() <= 7) {
      months.push({ t: MONTHS[m]!.slice(0, 1), c: 'text' })
      lastMonth = m
    } else months.push({ t: ' ' })
  }
  lines.push(months)
  const labels = ['Mon', '', 'Wed', '', 'Fri', '', '']
  for (let d = 0; d < 7; d += 1) {
    const row: Seg[] = [{ t: `${labels[d]!.padEnd(3)} `, c: 'text' }]
    for (let w = 0; w < WEEKS; w += 1) {
      const t = firstMonday + w * 7 * DAY_MS + d * DAY_MS
      if (t > todayUtc) {
        row.push({ t: ' ' })
        continue
      }
      const a = byDay.get(dayKey(t))
      const lv = level(a?.messageCount ?? 0)
      row.push(lv === 0 ? { t: GLYPH[0]!, d: true } : { t: GLYPH[lv]!, c: accent })
    }
    lines.push(row)
  }
  lines.push([{ t: '    Less ', c: 'text' }, { t: '░▒▓█', c: accent }, { t: ' More', c: 'text' }])
  lines.push([])

  // Figures for the chosen period.
  const days = activity.filter(a => inPeriod(a.date))
  const tokenDays = (cache.dailyModelTokens ?? []).filter(a => inPeriod(a.date))
  const perModel = new Map<string, number>()
  for (const day of tokenDays) for (const [m, n] of Object.entries(day.tokensByModel)) perModel.set(m, (perModel.get(m) ?? 0) + n)
  const favourite = [...perModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
  const totalTokens = [...perModel.values()].reduce((a, b) => a + b, 0)
  const sessions = period === 'all' ? cache.totalSessions ?? days.reduce((a, d) => a + d.sessionCount, 0) : days.reduce((a, d) => a + d.sessionCount, 0)
  const first = cache.firstSessionDate ? new Date(cache.firstSessionDate).getTime() : now
  const span = Math.max(1, Math.floor((todayUtc - Math.max(first, cutoff)) / DAY_MS) + 1)
  const activeDays = days.length
  const busiest = [...days].sort((a, b) => b.messageCount - a.messageCount)[0]
  const dateLabel = (date: string) => {
    const dt = new Date(`${date}T12:00:00Z`)
    return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`
  }
  // Streaks over the active dates.
  const active = new Set(activity.map(a => a.date))
  let longest = 0
  let current = 0
  for (let t = todayUtc; t >= first - DAY_MS; t -= DAY_MS) {
    if (active.has(dayKey(t))) current += 1
    else break
  }
  let run = 0
  for (let t = first; t <= todayUtc; t += DAY_MS) {
    run = active.has(dayKey(t)) ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  const usage = Object.values(cache.modelUsage ?? {})
  const sum = (k: 'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens') => usage.reduce((a, u) => a + (u[k] ?? 0), 0)
  const periodLine: Seg[] = []
  for (const p of ['all', '30', '7'] as const) {
    if (periodLine.length) periodLine.push({ t: ' · ', d: true })
    periodLine.push(p === period ? { t: PERIOD_LABEL[p], c: accent, b: true } : { t: PERIOD_LABEL[p], d: true })
  }
  periodLine.push({ t: '   (←→ on the Period row switches)', d: true })
  lines.push(periodLine)
  lines.push([])
  const COL = Math.max(28, `Favorite model: ${favourite}`.length + 3)
  const pair = (l1: string, v1: string, l2: string, v2: string): Seg[] => [
    { t: `${l1}: `, c: 'text' }, { t: v1.padEnd(Math.max(1, COL - l1.length - 2)), c: accent, b: true },
    { t: `${l2}: `, c: 'text' }, { t: v2, c: accent, b: true },
  ]
  lines.push(pair('Favorite model', favourite, 'Total tokens', bigNumber(totalTokens)))
  lines.push([])
  lines.push(pair('Sessions', String(sessions), 'Longest session', cache.longestSession ? duration(cache.longestSession.duration) : '—'))
  lines.push([
    { t: 'Active days: ', c: 'text' }, { t: `${activeDays}`, c: accent, b: true }, { t: `/${span}`.padEnd(Math.max(1, COL - 13 - String(activeDays).length)), d: true },
    { t: 'Longest streak: ', c: 'text' }, { t: `${longest} days`, c: accent, b: true },
  ])
  lines.push(pair('Most active day', busiest ? dateLabel(busiest.date) : '—', 'Current streak', `${current} days`))
  if (period === 'all') {
    lines.push([{ t: `Input ${bigNumber(sum('inputTokens'))} · Output ${bigNumber(sum('outputTokens'))} · Cache read ${bigNumber(sum('cacheReadInputTokens'))} · Cache write ${bigNumber(sum('cacheCreationInputTokens'))}`, d: true }])
  } else {
    lines.push([{ t: 'token split by kind is kept for all time only', d: true }])
  }
  return lines
}

const headline = (limits: Limit[], now: number): string => {
  const week = limits.find(l => l.kind === 'weekly_all' || l.kind === 'seven_day')
  if (!week?.resetsAt) return ''
  const resets = new Date(week.resetsAt).getTime()
  const elapsedShare = Math.max(0, Math.min(1, 1 - (resets - now) / (7 * 86_400_000)))
  const day = new Date(resets).toLocaleDateString([], { weekday: 'long' })
  if (week.percent >= 95) return `Weekly limit nearly used · resets ${day}`
  if (week.percent <= elapsedShare * 100 + 15) return `On track · room to spare before ${day}'s reset`
  return `Running hot · pace exceeds ${day}'s reset`
}

// The probe is a harmless write to the temp folder. It is only ever run to make the permission check ask.
const BYPASS_PROBE = 'touch /tmp/cc-dock-bypass-probe'

// Bypass. The engine has no call that changes the session's mode, but a permission prompt's answer can carry a
// "set mode for this session" update. So a confirmed press runs the probe: if the permission check would ask,
// the prompt is answered with that update; if it would allow the probe, there is no prompt to ride on and the
// dock says so rather than claiming a switch it did not make.
async function bypassPress($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (bypassWanted) {
    bypassWanted = false
    bypassNote = ''
    redraw($)
    return
  }
  if (!(bypassArmedAt && now - bypassArmedAt < CONFIRM_MS)) {
    bypassArmedAt = now
    redraw($)
    return
  }
  bypassArmedAt = 0
  let verdict = 'ask'
  if (permissionMode === 'bypass') verdict = 'allow'
  else {
    try {
      verdict = (await $.tool.check({ tool: 'Bash', input: { command: BYPASS_PROBE } })).decision
    } catch {
      verdict = 'ask'
    }
  }
  if (verdict === 'deny') {
    bypassNote = 'bypass: blocked'
    redraw($)
    return
  }
  if (verdict === 'allow') {
    bypassNote = 'already enabled'
    void $.clock.sleep(2_500).then(() => { bypassNote = ''; redraw($) }).catch(() => {})
    redraw($)
    return
  }
  bypassWanted = true
  bypassNote = 'switching…'
  redraw($)
  // Runs the probe and reports how it ended; the checker cannot follow the engine's tool types through a chain here.
  const ran = await runProbe($)
  if (ran.ok) {
    // The probe finished without the prompt the switch rides on: nothing switched.
    if (bypassWanted) {
      bypassWanted = false
      bypassNote = 'already enabled'
      void $.clock.sleep(2_500).then(() => { bypassNote = ''; redraw($) }).catch(() => {})
      redraw($)
    }
    return
  }
  bypassWanted = false
  bypassNote = `bypass: ${ran.message}`
  redraw($)
}

async function runProbe($: EngineInterface): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // The engine's tool.call overloads exceed TypeScript's depth limit (TS2589) in this engine version; the call itself is valid.
    // @ts-expect-error TS2589 from the engine's tool.call overloads
    const ran = (await $.tool.call({ tool: 'Bash', command: BYPASS_PROBE, description: 'Dock permission probe' } as never)) as { deny?: string; isError?: boolean; text?: string } | undefined
    // A refused or failed probe resolves rather than throws; it must not read as a probe that ran clean.
    if (ran?.deny !== undefined) return { ok: false, message: ran.deny }
    if (ran?.isError) return { ok: false, message: ran.text || 'the probe failed' }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'the probe did not run' }
  }
}

function redraw($: EngineInterface): void {
  $.ui.invalidate('ui.render')
}

// The login record holds the plan tier and the token the usage endpoint wants. The token stays in
// this function's scope and is never logged, drawn or stored.
async function readLogin($: EngineInterface): Promise<{ token: string; tier: string } | null> {
  let raw = ''
  try {
    // The login is filed under the account name; an older entry under another account can hold only the MCP tokens.
    const user = await $.env.get('USER').then(v => v ?? '', () => '')
    const r = await $.process.run(['security', 'find-generic-password', '-s', 'Claude Code-credentials', ...(user ? ['-a', user] : []), '-w'])
    if (r.exitCode === 0) raw = r.stdout.trim()
  } catch {
    raw = ''
  }
  if (!raw) {
    try {
      const home = (await $.env.get('HOME')) ?? ''
      raw = await $.fs.read(`${home}/.claude/.credentials.json`)
    } catch {
      return null
    }
  }
  try {
    const o = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string; rateLimitTier?: string; subscriptionType?: string } }
    const auth = o.claudeAiOauth
    if (!auth?.accessToken) return null
    return { token: auth.accessToken, tier: auth.rateLimitTier ?? auth.subscriptionType ?? '' }
  } catch {
    return null
  }
}

type UsageJson = {
  limits?: { kind: string; percent: number; resets_at?: string; scope?: { model?: { display_name?: string } } | null }[]
  seven_day_breakdown?: { rows?: { key: string; percent: number }[] }
} & Record<string, unknown>

function parseUsage(json: UsageJson, tier: string, now: number): Plan {
  const limits: Limit[] = []
  for (const l of json.limits ?? []) {
    const scoped = l.kind === 'weekly_scoped' ? l.scope?.model?.display_name : undefined
    const label = l.kind === 'session' ? 'Session' : l.kind === 'weekly_all' ? 'Week' : scoped ? scoped : l.kind
    limits.push({ kind: l.kind, label, percent: l.percent, resetsAt: l.resets_at })
  }
  const code = json.seven_day_breakdown?.rows?.find(r => r.key === 'claude_code')
  return { tier: TIER_LABEL[tier] ?? tier, limits, codeShare: code?.percent, fetchedAt: now }
}

// Panes open at once, mid-turn or not; a slash command would wait in the prompt queue.
const DOCK_PANES = [CONFIG_PANE]
async function openPane($: EngineInterface, id: string, title: string): Promise<void> {
  try {
    // One dock pane at a time, so the engine draws no tab row above it; the dock's own buttons switch.
    for (const other of DOCK_PANES) {
      if (other === id) continue
      try {
        await $.ui.close({ id: other })
      } catch {
        // not open
      }
    }
    const opened = await $.ui.open({ id, title, focus: true, closeOnEscape: true })
    usageNote = opened.isPlaced ? '' : `widen the terminal to see ${title}`
  } catch (err) {
    usageNote = err instanceof Error ? err.message : `could not open ${title}`
  }
  redraw($)
}

async function loadBreakdown($: EngineInterface, columns: number): Promise<void> {
  if (breakdownBusy) return
  breakdownBusy = true
  breakdownNote = 'counting…'
  const started = conversationEpoch
  redraw($)
  try {
    const usage = await $.session.usage({ breakdown: 'full', columns })
    // A count that finishes after /clear belongs to the conversation it started in, so it is dropped.
    if (started !== conversationEpoch) return
    context = usage.context
    breakdown = usage.context.breakdown ?? null
    breakdownNote = breakdown ? '' : 'no breakdown available'
  } catch (err) {
    if (started === conversationEpoch) breakdownNote = err instanceof Error ? err.message : 'could not count the context'
  } finally {
    breakdownBusy = false
    redraw($)
  }
}
// Bumped at each new conversation, so late replies from the old one can be recognised and dropped.
let conversationEpoch = 0

// First press arms the button (it reads "Yes?"), the second within CONFIRM_MS compacts; a stray click does nothing.
async function compactPress($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (compactArmedAt && now - compactArmedAt < CONFIRM_MS) {
    compactArmedAt = 0
    await compactNow($)
    return
  }
  compactArmedAt = now
  redraw($)
}

// The engine compacts only between turns; mid-turn the request is queued so it runs the moment the turn ends.
async function compactNow($: EngineInterface): Promise<void> {
  const started = await $.clock.now()
  compacting = true
  compactAsked = false
  compactNote = ''
  bubble = 'compacting.'
  bubbleSince = started
  bubbleHold = 10 * 60_000
  startStars($)
  redraw($)
  try {
    const result = await $.session.compact()
    compacting = false
    if (result.skip !== undefined) {
      refuseCompact($, String(result.skip))
    } else {
      compactions += 1
      setBubble($, 'success!', 3_000)
      await readUsage($)
    }
  } catch (err) {
    compacting = false
    // A press that landed mid-turn waits for the turn to end; any other failure is shown, not retried later.
    const message = err instanceof Error ? err.message : 'did not run'
    if (turnRunning || /turn/i.test(message)) {
      compactWhenIdle = true
      setBubble($, 'compacts after this turn', 4_000)
    } else {
      refuseCompact($, message)
    }
  }
  redraw($)
}

// The bubble says it did not run; the reason, too long for its few words, goes beside the buttons for a while.
function refuseCompact($: EngineInterface, reason: string): void {
  setBubble($, 'not compacted', 4_000)
  compactNote = reason
  void $.clock.sleep(8_000).then(() => {
    if (compactNote !== reason) return
    compactNote = ''
    redraw($)
  }).catch(() => {})
}

// Shows a line in the avatar's bubble for a set time.
function setBubble($: EngineInterface, text: string, holdMs: number): void {
  void $.clock.now().then(now => {
    bubble = text
    bubbleSince = now
    bubbleHold = holdMs
    redraw($)
  })
}

// Reads the live figures for the current conversation.
async function readUsage($: EngineInterface): Promise<void> {
  try {
    const usage = await $.session.usage()
    context = usage.context
    rateLimits = usage.rateLimits
    rateLimitsFresh = usage.rateLimits.length > 0
    cost = usage.cost
    sessionStartedAt = usage.startedAt
    breakdown = null
    breakdownNote = ''
    // An open Context view draws the breakdown just cleared; count it again rather than leave it on "counting…".
    if (view === 'context' && bandColumns > 0) void loadBreakdown($, bandColumns)
  } catch {
    // the figures refresh on the next response
  }
}

async function syncModel($: EngineInterface): Promise<void> {
  try {
    const now = await $.session.model()
    if (now && now !== model) {
      model = now
      redraw($)
    }
  } catch {
    // keep the last reading
  }
}

// The model, its reasoning level and fast mode, as /model and /config show them.
async function loadModelInfo($: EngineInterface): Promise<void> {
  try {
    model = await $.session.model()
  } catch {
    // keep the last reading
  }
}

// A chip press: the lit level again clears the override, another sets it; the store keeps it across sessions.
let effortPending: ModelEffort | '' = ''
// Usage by model, summed from every turn.complete since the dock loaded (the engine's own totals since
// session start are not exposed).
type ModelTally = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
const tally = new Map<string, ModelTally>()
let requests = 0
let apiMs = 0 // a level to hand /effort once the session is idle

// Runs /effort <level> as typed: the only way the running session's own level changes. Idle it runs at
// once; mid-turn it waits for turn.complete, so nothing queues behind a prompt.
// One /effort run at a time. A pick made while one runs waits for it and goes next; an older run never undoes a newer pick.
// A pick waits this long before it is sent, so quick clicks replace each other and only the last one is sent.
const SETTLE_MS = 400
let effortTimer: { cancel: () => void } | null = null
let ultraTimer: { cancel: () => void } | null = null
// The level the engine last confirmed, so picking it again can cancel a switch that has not gone out yet.
let engineEffort: ModelEffort | '' = ''
let effortRunning = false
async function applyEffortLive($: EngineInterface): Promise<void> {
  if (effortRunning || turnRunning) return
  const level = effortPending
  if (!level) return
  effortPending = ''
  effortRunning = true
  try {
    const result = await ownCommand($, { command: 'effort', args: level })
    readEffortText(result.text)
    engineEffort = level
    if (effortOverride === level) {
      if (!result.text) effort = level
      effortOverride = ''
    }
    if (effortBusy?.level === level) effortBusy.carried = true
    configNote = ''
  } catch (err) {
    if (effortBusy?.level === level) effortBusy = null
    configNote = `effort: ${err instanceof Error ? err.message : '/effort did not run'}`
  } finally {
    effortRunning = false
  }
  if (effortPending) await applyEffortLive($)
  redraw($)
}

// /effort's own words carry the state: "Ultracode on (this session only) … Effort stays high.",
// "Ultracode off. Effort stays high.", "Effort set to xhigh". A level the person chose there is the
// real one, so it also clears any level the dock had been forcing. Answers whether the reply named a level.
function readEffortText(text: string | undefined): boolean {
  if (!text) return false
  if (/ultracode\s+on/i.test(text)) ultracode = true
  else if (/ultracode\s+off/i.test(text)) ultracode = false
  // "Effort stays high", "Set effort level to low (…)", "Effort set to xhigh", "effort: medium".
  const m = /effort(?:\s+level)?\s*(?:stays|set to|is now|is|to|:)?\s*(low|medium|high|xhigh|max)\b/i.exec(text)
  if (!m) return false
  const level = m[1]!.toLowerCase() as ModelEffort
  engineEffort = level
  // A newer pick still waiting keeps the requests and the chip; an older run's reply must not undo it.
  if (!effortPending) {
    effort = level
    effortOverride = ''
  }
  return true
}

// Whatever the dock still meant to switch is moot once the person has settled it with a typed /effort.
function dropPendingSwitches(): void {
  if (effortTimer) effortTimer.cancel()
  if (ultraTimer) ultraTimer.cancel()
  effortTimer = null
  ultraTimer = null
  effortPending = ''
  ultraPending = ''
  effortBusy = null
  ultraBusy = null
  effortOverride = ''
}

// Ultracode is session state the engine switches only through `/effort ultracode on|off`; run it idle, or
// after the running turn ends, never queued behind a prompt.
let ultraRunning = false
async function applyUltracodeLive($: EngineInterface): Promise<void> {
  if (ultraRunning || turnRunning) return
  const want = ultraPending
  if (!want) return
  ultraPending = ''
  ultraRunning = true
  try {
    const result = await ownCommand($, { command: 'effort', args: `ultracode ${want}` })
    readEffortText(result.text)
    if (!result.text) ultracode = want === 'on'
    if (ultraBusy?.want === want) ultraBusy = null
    configNote = ''
  } catch (err) {
    if (ultraBusy?.want === want) ultraBusy = null
    configNote = `ultracode: ${err instanceof Error ? err.message : '/effort did not run'}`
  } finally {
    ultraRunning = false
  }
  if (ultraPending) await applyUltracodeLive($)
  redraw($)
}

// The mascot's word of warning when bypass comes on: five seconds, over anything else he was saying.
const careful = (now: number): void => {
  if (slim) return
  bubble = 'Careful!'
  bubbleHold = 5_000
  bubbleSince = now
}

// UltraCode is a queued /effort command too: its chip shows the star until the engine confirms the switch.
// A click while one waits flips what was asked for, so the last click always wins.
async function toggleUltracode($: EngineInterface): Promise<void> {
  const want = ultraBusy ? (ultraBusy.want === 'on' ? 'off' : 'on') : ultracode ? 'off' : 'on'
  // Asking for what the engine already holds cancels whatever was waiting; nothing is sent.
  if ((want === 'on') === ultracode && !ultraRunning) {
    if (ultraTimer) ultraTimer.cancel()
    ultraTimer = null
    ultraPending = ''
    ultraBusy = null
    configNote = ''
    redraw($)
    return
  }
  ultraBusy = { want, since: await $.clock.now() }
  startStars($)
  ultraPending = want
  configNote = ''
  if (ultraTimer) ultraTimer.cancel()
  ultraTimer = $.clock.after(SETTLE_MS, () => {
    ultraTimer = null
    void applyUltracodeLive($)
  })
  redraw($)
}

// Whatever the dock still means to switch, done the moment the session is idle; called after each turn and
// again on the idle checks, so a switch pressed during back-to-back turns is never left hanging.
// A turn that never reports its end (a dropped call, a crash inside a hook) must not hold pending switches forever.
async function watchTurn($: EngineInterface): Promise<void> {
  if (!turnRunning) return
  if ((await $.clock.now()) - lastStepAt > 10 * 60_000) {
    turnRunning = false
    void flushPending($)
    redraw($)
  }
}

async function flushPending($: EngineInterface): Promise<void> {
  if (turnRunning) return
  if (effortPending) await applyEffortLive($)
  if (ultraPending) await applyUltracodeLive($)
  if (fastPending) await toggleFast($)
}

// A command the dock runs itself. The /effort hook ignores these, so a pending switch survives them.
let selfRuns = 0
async function ownCommand($: EngineInterface, input: { command: string; args?: string }) {
  selfRuns += 1
  try {
    return await $.command.run(input as never)
  } finally {
    selfRuns -= 1
  }
}

// The effort chip while its level is on its way: the spider's spinner stands in for the word, and the brackets light
// once the engine has the level. A flash lasts at least STAR_MIN_MS and never more than STAR_MAX_MS, so it cannot hang.
const STAR_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽']
const STAR_MIN_MS = 700
const STAR_MAX_MS = 4_000
let effortBusy: { level: ModelEffort; since: number; carried: boolean } | null = null
let starFrame = 0
let ultraBusy: { want: 'on' | 'off'; since: number } | null = null
const starLabel = (level: string): string => {
  const room = level.length - 1
  const left = Math.floor(room / 2)
  return `${'\u00a0'.repeat(left)}${STAR_FRAMES[starFrame % STAR_FRAMES.length] ?? '·'}${'\u00a0'.repeat(room - left)}`
}
// The star's timer runs only while a chip is spinning; it stops itself once both chips have settled.
let starTimer: { cancel: () => void } | null = null
function startStars($: EngineInterface): void {
  if (starTimer) return
  starTimer = $.clock.every(120, () => {
    void settleEffortBusy($)
  })
}
async function settleEffortBusy($: EngineInterface): Promise<void> {
  if (effortBusy) {
    const elapsed = (await $.clock.now()) - effortBusy.since
    if ((effortBusy.carried && elapsed >= STAR_MIN_MS) || elapsed >= STAR_MAX_MS) effortBusy = null
  }
  starFrame += 1
  if (compacting) bubble = `compacting${'.'.repeat((Math.floor(starFrame / 3) % 3) + 1)}`
  if (!effortBusy && !ultraBusy && !compacting && starTimer) {
    starTimer.cancel()
    starTimer = null
  }
  redraw($)
}

async function setEffort($: EngineInterface, level: ModelEffort): Promise<void> {
  // The lit chip is already this level: nothing to do.
  if (level === (effortOverride || effort)) return
  // max costs the most, so the person confirms it: /effort max goes into the prompt, and Enter runs it.
  if (level === 'max') {
    if (effortTimer) effortTimer.cancel()
    effortTimer = null
    effortPending = ''
    effortOverride = ''
    effortBusy = null
    try {
      const fill = await $.prompt.fill({ text: '/effort max' })
      configNote = fill?.isFilled === false ? 'max: type /effort max and press Enter' : 'max: press Enter in the prompt to confirm'
    } catch {
      configNote = 'max: type /effort max and press Enter'
    }
    redraw($)
    return
  }
  // Picking the level the engine already holds cancels whatever was waiting: nothing is sent.
  if (level === engineEffort && !effortRunning) {
    if (effortTimer) effortTimer.cancel()
    effortTimer = null
    effortOverride = ''
    effortPending = ''
    effortBusy = null
    effort = level
    redraw($)
    return
  }
  // Until /effort has run, the dock bridges the gap by rewriting each request's effort itself.
  effortOverride = level
  effort = level
  // The next request carries the level now; /effort is sent once the picks settle, or when the session is idle.
  effortPending = effortOverride
  effortBusy = { level, since: await $.clock.now(), carried: false }
  starFrame = 0
  startStars($)
  if (effortTimer) effortTimer.cancel()
  effortTimer = $.clock.after(SETTLE_MS, () => {
    effortTimer = null
    void applyEffortLive($)
  })
  redraw($)
}

// /fast's own words decide the state; without a readable answer the press is taken at its word.
function readFastText(text: string | undefined): void {
  if (!text) return
  fastReply = text.trim()
  if (/disabled|turned off|\boff\b/i.test(text)) fastMode = false
  else if (/enabled|turned on|\bon\b/i.test(text)) {
    fastMode = true
    fastQuipDue = true
  }
}

// The Fast button runs /fast like a typed command: at once when idle, after the turn when one runs.
let fastPending = false // a /fast to run once the turn ends
async function toggleFast($: EngineInterface): Promise<void> {
  if (turnRunning) {
    fastPending = true
    fastNote = 'after this turn'
    redraw($)
    return
  }
  fastPending = false
  fastNote = ''
  try {
    const result = await ownCommand($, { command: 'fast' })
    readFastText(result.text)
    fastNote = ''
  } catch (err) {
    fastNote = err instanceof Error ? err.message : 'could not run /fast'
  }
  redraw($)
}

// The usage request gives up after a few seconds, so one hung connection cannot freeze the reading.
function withTimeout<T>($: EngineInterface, work: Promise<T>, ms = 8_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // The timer is cancelled as soon as the request settles, so no wait outlives the request.
    const timer = $.clock.after(ms, () => reject(new Error('usage request timed out')))
    work.then(
      value => {
        timer.cancel()
        resolve(value)
      },
      err => {
        timer.cancel()
        reject(err)
      },
    )
  })
}

async function refreshPlan($: EngineInterface, minAge = REFRESH_MS): Promise<void> {
  const now = await $.clock.now()
  if (fetching || now < backoffUntil || now - lastFetchAt < minAge) return
  fetching = true
  lastFetchAt = now
  try {
    const login = await readLogin($)
    if (!login) {
      planError = 'not signed in'
      return
    }
    tier = TIER_LABEL[login.tier] ?? login.tier
    const res = await withTimeout($, $.http.fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    }))
    if (res.status === 429) {
      const retryAfter = Number(res.headers['retry-after'])
      backoffMs = retryAfter > 0 ? retryAfter * 1000 : Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, backoffMs * 2))
      backoffUntil = now + backoffMs
      planError = 'usage endpoint busy, retrying later'
      return
    }
    if (!res.ok) {
      planError = `usage endpoint ${res.status}`
      return
    }
    plan = parseUsage(JSON.parse(res.text) as UsageJson, login.tier, now)
    rateLimitsFresh = false
    planError = ''
    backoffMs = 0
    try {
      await $.store.set('plan', plan)
    } catch {
      // the store is a convenience; the reading is still on screen
    }
  } catch {
    planError = 'usage endpoint unreachable'
  } finally {
    fetching = false
    redraw($)
  }
}

// A reload starts from the last reading saved, so the header never blanks while the endpoint is asked again.
async function loadSavedPlan($: EngineInterface): Promise<void> {
  // Each saved value has its own guard, so one unreadable value cannot reset the rest to defaults.
  const stored = async (key: string): Promise<unknown> => {
    try {
      return await $.store.get(key)
    } catch {
      return undefined
    }
  }
  const folded = (await stored('folded')) as { plan?: boolean; chat?: boolean } | undefined
  planOpen = folded?.plan !== true
  chatOpen = folded?.chat !== true
  try {
    const settings = (await $.settings.read({ source: 'user' })) as { ultracode?: unknown }
    ultracode = settings.ultracode === true
  } catch {
    ultracode = false
  }
  slim = (await stored('slim')) === true
  const savedLook = (await stored('look')) as Partial<DockLook> | undefined
  if (savedLook && typeof savedLook === 'object') look = { ...look, ...savedLook }
  autoBackground = (await stored('autoBackground')) === true
  showBypass = (await stored('showBypass')) === true

  const savedSounds = (await stored('sounds')) as Record<string, unknown> | undefined
  if (savedSounds && typeof savedSounds === 'object') {
    // A pick names a sound that still exists; anything else (an older numbered pick) keeps the default.
    const pick = (v: unknown, d: string) => (v === '' || (typeof v === 'string' && SOUNDS.some(x => x.id === v)) ? v : d)
    sounds = {
      done: pick(savedSounds.done, sounds.done),
      needs: pick(savedSounds.needs, sounds.needs),
      agent: pick(savedSounds.agent, sounds.agent),
      volume: typeof savedSounds.volume === 'number' ? savedSounds.volume : sounds.volume,
      notify: savedSounds.notify !== false,
      voice: savedSounds.voice !== false,
    }
  }
  const shirtSaved = (await stored('shirt')) as number | undefined
  shirt = typeof shirtSaved === 'number' && shirtSaved >= 0 && shirtSaved < SHIRTS.length ? shirtSaved : 0
  // A level forced in an earlier session is not carried over: the engine's own setting rules at start.
  effortOverride = ''
  try {
    const saved = (await $.store.get('plan')) as Plan | undefined
    if (saved && Array.isArray(saved.limits)) {
      plan = saved
      tier = saved.tier
      const now = await $.clock.now()
      lastFetchAt = now < saved.fetchedAt ? 0 : saved.fetchedAt
    }
  } catch {
    // nothing saved yet
  }
}

// Background shells stream to /private/tmp/claude-<uid>/<cwd slug>/<session>/tasks/<task>.output.
async function locateTasksDir($: EngineInterface): Promise<void> {
  try {
    const [uid, cwd, id] = await Promise.all([
      $.process.run(['id', '-u']).then(r => r.stdout.trim()),
      $.session.cwd(),
      $.session.id(),
    ])
    tasksDir = `/private/tmp/claude-${uid}/${cwd.replace(/[^A-Za-z0-9]/g, '-')}/${id}/tasks`
  } catch {
    tasksDir = ''
  }
}

async function tailOutput($: EngineInterface, taskId: string, lines: number, width: number): Promise<string[]> {
  if (!tasksDir) return []
  try {
    const text = await $.fs.read(`${tasksDir}/${taskId}.output`)
    const all = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '')
    return all.slice(-lines).map(l => (l.length > width ? `${l.slice(0, width - 1)}…` : l))
  } catch {
    return []
  }
}

// Backgrounded shells end out of band: the Stop hooks carry what is still in flight.
// The engine's list of background work: ends the shells it no longer has, and adopts running ones the dock never
// saw start (begun before a load or reload), so their output can be opened too.
type InFlight = { id: string; type?: string; status?: string; description?: string; command?: string }
async function pruneBackground($: EngineInterface, inFlight: readonly InFlight[] | undefined): Promise<void> {
  if (!inFlight) return
  const live = new Set(inFlight.map(t => t.id))
  const now = await $.clock.now()
  for (const shell of shells.values()) {
    if (shell.taskId && !live.has(shell.taskId) && shell.endedAt === undefined) shell.endedAt = now
  }
  const known = new Set([...shells.values()].map(x => x.taskId).filter(Boolean))
  for (const t of inFlight) {
    const isShell = t.type === 'shell' || t.type === 'workflow' || t.command !== undefined
    if (!isShell || known.has(t.id) || /done|complete|fail|kill|stop/i.test(t.status ?? '')) continue
    shells.set(`bg-${t.id}`, {
      toolUseId: `bg-${t.id}`,
      description: t.description || (t.command ?? '').slice(0, 60) || 'background shell',
      command: t.command ?? '',
      startedAt: now,
      taskId: t.id,
    })
  }
  redraw($)
}

// The footer's own count of background shells ("· 1 shell ·"), the engine's word even for shells the dock missed.
let engineShells = 0

function dropLingered(now: number): void {
  for (const [key, shell] of shells) {
    if (shell.endedAt !== undefined && now - shell.endedAt > LINGER_MS) {
      shells.delete(key)
      expanded.delete(key)
    }
  }
}

// Bulk brings back the whole dock, every section open whatever was folded before, and the mascot climbs
// the ladder its full height gives him.
async function toggleSlim($: EngineInterface): Promise<void> {
  slim = !slim
  if (slim) {
    bubble = ''
    scene = null
    react = null
    talk = null
  } else {
    planOpen = true
    chatOpen = true
    climb += 1
    climbAt = Date.now()
  }
  redraw($)
  try {
    await $.store.set('slim', slim)
    if (!slim) await $.store.set('folded', { plan: false, chat: false })
  } catch {
    // remembered for this session only
  }
}

async function toggleSection($: EngineInterface, which: 'plan' | 'chat'): Promise<void> {
  if (which === 'plan') planOpen = !planOpen
  else chatOpen = !chatOpen
  redraw($)
  try {
    await $.store.set('folded', { plan: !planOpen, chat: !chatOpen })
  } catch {
    // remembered for this session only
  }
}

async function startConversation($: EngineInterface): Promise<void> {
  conversationEpoch += 1
  tally.clear()
  requests = 0
  apiMs = 0
  shells.clear()
  expanded.clear()
  engineShells = 0
  effortOverride = ''
  effortPending = ''
  effortBusy = null
  engineEffort = ''
  ultraPending = ''
  ultraBusy = null
  fastPending = false
  compactWhenIdle = false
  compactArmedAt = 0
  compactNote = ''
  bypassWanted = false
  bypassArmedAt = 0
  bypassNote = ''
  usageNote = ''
  configNote = ''
  fastNote = ''
  turnRunning = false
  breakdown = null
  breakdownNote = ''
  breakdownBusy = false
  if (view === 'context') view = 'dash'
  talk = null
  react = null
  lastTurnEndAt = 0
  await readUsage($)
  await readSessionSettings($)
  await locateTasksDir($)
  redraw($)
}

// The settings the engine holds for this session: fast mode and the effort level, read as the config rows show them.
async function readSessionSettings($: EngineInterface): Promise<void> {
  try {
    const rows = await $.config.list()
    const fast = rows.find(r => r.key === 'fastMode')
    if (fast) fastMode = fast.value === true
    const level = rows.find(r => r.key === 'effort')
    if (level && typeof level.value === 'string' && EFFORTS.includes(level.value as ModelEffort)) {
      effort = level.value
      engineEffort = level.value as ModelEffort
    }
  } catch {
    // the dock keeps the last reading
  }
}

export const register: Register = (on) => {

  // /clear, /resume and /branch begin a conversation without session.start, so its figures start afresh here.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await startConversation($)
    return next(e)
  })
  // A compaction (typed, automatic or from the dock) changes the figures but not the conversation.
  on('classic.SessionStart', { source: ['compact'] }, async ($, e, next) => {
    await readUsage($)
    redraw($)
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    try {
      const usage = await $.session.usage()
      context = usage.context
      rateLimits = usage.rateLimits
      cost = usage.cost
      sessionStartedAt = usage.startedAt
    } catch {
      // session.measure fills it after the first turn
    }
    for (const id of DOCK_PANES) {
      try {
        await $.ui.close({ id })
      } catch {
        // not open
      }
    }
    try {
      const home = (await $.env.get('HOME')) ?? ''
      const root = JSON.parse(await $.fs.read(`${home}/.claude.json`)) as { oauthAccount?: { displayName?: string; fullName?: string } }
      const full = root.oauthAccount?.displayName || root.oauthAccount?.fullName || ''
      userName = full.split(/\s+/)[0] ?? ''
    } catch {
      userName = ''
    }
    say('hello', await $.clock.now())
    // Quiet time counts from when the dock loads, so a resumed old session does not chatter at once.
    await noteActivity($)
    await loadSavedPlan($)
    await readSessionSettings($)
    await loadModelInfo($)
    void refreshPlan($, 0)
    void locateTasksDir($)
    for (const command of [
      { name: 'snake', description: 'The dock mascot chases a snake.' },
      { name: 'ladder', description: 'The dock mascot climbs a ladder.' },
      { name: 'chatter', description: 'The dock mascot says what he says now.' },
    ]) {
      try {
        await $.command.register(command)
      } catch {
        // another plugin may own the name
      }
    }
    $.clock.every(5_000, () => {
      void refreshPlan($)
      void watchTurn($)
      void flushPending($)
    })
    $.clock.every(1_000, () => {
      void syncModel($)
      void chatterTick($)
    })
    $.clock.every(90_000, () => {
      if (turnRunning) return
      void $.clock.now().then(now => {
        const idleFor = now - Math.max(lastTurnEndAt, sessionStartedAt)
        if (idleFor >= 3 * 60_000 && !scene && !react && !slim && look.avatar && Math.random() < 0.12) {
          rollReaction()
          redraw($)
        }
      })
      const pct = context?.percent ?? 0
      if (pct < 90) compactAsked = false
      void $.clock.now().then(now => {
        if (pct >= 90 && !compactAsked && !compacting && view === 'dash' && !slim && look.avatar) {
          compactAsked = true
          bubble = 'Compact?'
          bubbleSince = now
          bubbleHold = 12_000
        } else {
          say(pct >= 80 && lastQuipKind !== 'full' ? 'full' : 'idle', now)
        }
        redraw($)
      })
    })
    $.clock.every(80, () => {
      if (!scene && !look.ruleShimmer) return
      if (scene) scene = { ...scene, t: scene.t + 1 }
      if (look.ruleShimmer) ruleFrame += 1
      redraw($)
    })
    $.clock.every(700, () => {
      frame = (frame + 1) % DANCE.length
      if (fastQuipDue) {
        fastQuipDue = false
        void $.clock.now().then(now => { say('fast', now); redraw($) })
      }
      if (bubble) {
        void $.clock.now().then(now => {
          if (now - bubbleSince >= bubbleHold) {
            bubble = ''
            redraw($)
          }
        })
      }
      void $.clock.now().then(now => {
        if (react && react.id !== reactSeen.id) reactSeen = { id: react.id, at: now }
        const reactStale = react !== null && now - reactSeen.at > REACT_MAX_MS
        const talkStale = talk?.startedAt !== undefined && now - talk.startedAt > TALK_MAX_MS
        if (reactStale) react = null
        if (talkStale) talk = null
        if (reactStale || talkStale) redraw($)
      })
      redraw($)
    })
    return next(e)
  })

  on('session.measure', ($, e, next) => {
    context = e.context
    rateLimits = e.rateLimits
    rateLimitsFresh = e.rateLimits.length > 0
    cost = e.cost
    redraw($)
    void refreshPlan($, AFTER_TURN_MS)
    void loadModelInfo($).then(() => redraw($))
    return next(e)
  })

  // Each model request says which model and effort the turn really uses.
  on('turn.step', async function* ($, e, next) {
    requests += 1
    if (!e.agentId && e.index === 0) say('thinking', await $.clock.now())
    if (!e.agentId) {
      model = e.model
      turnRunning = true
      lastStepAt = await $.clock.now()
      void noteActivity($)
      // A level pressed on a chip rides on every request until /effort has run, whether or not the engine named one.
      if (effortOverride) {
        effort = effortOverride
        if (effortBusy?.level === effortOverride) effortBusy.carried = true
        redraw($)
        return yield* next({ ...e, effort: effortOverride })
      }
      effort = e.effort === undefined ? '' : String(e.effort)
      if (EFFORTS.includes(effort as ModelEffort)) engineEffort = effort as ModelEffort
      redraw($)
    }
    return yield* next(e)
  })

  // The engine's own spinner word ("Hyperspacing"), mirrored into the dock while the turn runs.
  // Whether a turn is running comes from turn.step and turn.complete alone. The engine also draws a spinner
  // while a plugin's own slash command runs, and no turn ends after that, so a spinner must not count.

  // A /fast the person types updates the button too.
  on('command.run', { command: 'ladder' }, ($) => {
    climb += 1
    climbAt = Date.now()
    redraw($)
    return {}
  })

  on('command.run', { command: 'chatter' }, ($) => {
    void speakNow($)
    return {}
  })

  on('command.run', { command: 'snake' }, ($) => {
    scene = { t: 0 }
    redraw($)
    return {}
  })

  on('command.run', { command: 'fast' }, async ($, e, next) => {
    const result = await next(e)
    readFastText(result.text)
    redraw($)
    return result
  })

  // A model switch shows at once: after /model, and within a second of the keyboard picker, which runs no command.
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const result = await next(e)
    await syncModel($)
    return result
  })

  // An /effort the person runs (or the dialog's Tab toggle, which answers through it) updates the state.
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const result = await next(e)
    // The person settled it themselves: drop anything the dock still meant to do. The dock's own runs don't count.
    const typed = selfRuns === 0
    if (typed) dropPendingSwitches()
    const named = readEffortText(result.text)
    if (typed && !named) await readSessionSettings($)
    if (/^(ultracode|effort)/.test(configNote)) configNote = ''
    redraw($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.usage) {
      const t = tally.get(e.usage.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
      t.input += e.usage.input_tokens
      t.output += e.usage.output_tokens
      t.cacheRead += e.usage.cache_read_input_tokens
      t.cacheWrite += e.usage.cache_creation_input_tokens
      t.turns += 1
      tally.set(e.usage.model, t)
      apiMs += e.durationMs
    }
    if (!e.agentId) {
      turnRunning = false
      lastTurnEndAt = await $.clock.now()
      spinnerWord = ''
      say('done', await $.clock.now())
      redraw($)
      void $.clock.sleep(1_500).then(() => refreshPlan($, 0)).catch(() => {})
      void $.clock.sleep(400).then(() => flushPending($)).catch(() => {})
      if (compactWhenIdle) {
        compactWhenIdle = false
        void $.clock.sleep(300).then(() => compactNow($)).catch(() => {})
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.command === BYPASS_PROBE) return next(e)
    // A server or watcher would hold the turn until it timed out; in the background the agent keeps going.
    const input = autoBackground && !e.run_in_background && neverEnds(e.command) ? { ...e, run_in_background: true } : e
    const id = e.tool_use_id ?? `${await $.clock.now()}`
    try {
      shells.set(id, {
        toolUseId: id,
        description: e.description ?? e.command.slice(0, 60),
        command: e.command,
        startedAt: await $.clock.now(),
        agentId: e.agentId,
      })
      redraw($)
    } catch {
      // the shells list is a view; the command runs regardless
    }
    try {
      const ran = await next(input)
      const taskId = ran.deny === undefined ? (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId : undefined
      const shell = shells.get(id)
      if (shell) {
        if (taskId) shell.taskId = taskId
        else {
          shell.endedAt = await $.clock.now()
          shell.failed = ran.deny !== undefined || ran.isError === true
        }
      }
      return ran
    } catch (err) {
      // A call that threw never reports an end, so its shell would show as running for good.
      const shell = shells.get(id)
      if (shell && shell.endedAt === undefined) {
        shell.endedAt = await $.clock.now()
        shell.failed = true
      }
      throw err
    } finally {
      redraw($)
    }
  })

  // The footer under the prompt names the permission mode; read it on every draw and pass it on untouched.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.component === 'PromptHint') {
      // The engine's own word on whether a turn runs: a switch waiting for "after this turn" never outlives it,
      // even when a side request (the auto-mode classifier, a title) started a step that no turn.complete ends.
      if (e.props.isDraft) void noteActivity($)
      const counted = /(\d+)\s+shells?\b/.exec(e.props.hint)
      const n = counted ? Number(counted[1]) : 0
      if (n !== engineShells) {
        engineShells = n
        redraw($)
      }
      // A footer that says the turn works is proof of life, so a long quiet wait (a workflow, a slow command) is not its end.
      if (e.props.isWorking && turnRunning) lastStepAt = await $.clock.now()
      if (!e.props.isWorking && turnRunning) {
        turnRunning = false
        void flushPending($)
        redraw($)
      }
      const found = MODE_WORDS.find(([re]) => re.test(e.props.hint))?.[1]
      // The footer names bypass while it is on; once it stops naming it, the dock stops saying so too.
      if (!found && permissionMode === 'bypass') {
        permissionMode = ''
        redraw($)
      }
      if (found && found !== permissionMode) {
        const wasKnown = permissionMode !== ''
        permissionMode = found
        if (found === 'bypass' && wasKnown) careful(await $.clock.now())
        redraw($)
      }
    }
    return next(e)
  })

  // Sounds for Claude waiting on you; the finished and agent sounds ride the Stop hooks below.
  // The idle reminder a minute after an answer is skipped: the finished sound already said so.
  on('classic.Notification', async ($, e, next) => {
    if (!/idle/i.test(String(e.notification_type ?? ''))) void chime($, 'needs')
    return next(e)
  })

  // A Stop with no background work still running is the whole answer in: the finished sound plays.
  // Claude's permission prompt for the Bypass probe: answer it with the mode update, and check that it took.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!bypassWanted || e.tool_name !== 'Bash' || (e.tool_input as { command?: unknown } | null)?.command !== BYPASS_PROBE) return next(e)
    bypassWanted = false
    bypassNote = 'switching…'
    void $.clock
      .sleep(1_500)
      .then(() => {
        bypassNote = permissionMode === 'bypass' ? 'this session is in bypass' : "didn't switch: bypass may not be allowed for this session"
        redraw($)
        return $.clock.sleep(8_000)
      })
      .then(() => {
        bypassNote = ''
        redraw($)
      })
      .catch(() => {})
    redraw($)
    return {
      decision: {
        behavior: 'allow',
        updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
      },
    }
  })

  on('classic.Stop', async ($, e, next) => {
    turnRunning = false
    void flushPending($)
    if (!e.background_tasks?.some(t => t.type !== 'shell' && !/done|complete|fail|kill|stop/i.test(t.status ?? ''))) void chime($, 'done')
    try {
      await pruneBackground($, e.background_tasks)
    } catch {
      // the shells list is a view; the stop goes on regardless
    }
    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    void chime($, 'agent')
    try {
      await pruneBackground($, e.background_tasks)
    } catch {
      // the shells list is a view; the stop goes on regardless
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.component !== 'AbovePrompt' || e.props.hasSurvey) return next(e)
    if (e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const els = { Box, Text, Button }
    const columns = e.props.bodyColumns
    bandColumns = columns
    const mascotWidth = 11
    const body = Math.max(40, columns - mascotWidth)
    const barWidth = Math.max(8, Math.min(28, Math.floor(body / 4)))
    const now = await $.clock.now()
    dropLingered(now)
    const actions: Record<string, () => Promise<void>> = {
      config: () => {
        configTab = 'dock'
        return openPane($, CONFIG_PANE, 'Settings')
      },
      fast: async () => { view = view === 'fast' ? 'dash' : 'fast'; redraw($) },
      slim: () => toggleSlim($),
      context: async () => {
        view = view === 'context' ? 'dash' : 'context'
        redraw($)
        if (view === 'context') void loadBreakdown($, columns)
      },
      compact: () => compactPress($),
      bypass: () => bypassPress($),
    }
    const compactArmed = compactArmedAt > 0 && now - compactArmedAt < CONFIRM_MS
    if (compactArmedAt && !compactArmed) compactArmedAt = 0
    const bypassArmed = bypassArmedAt > 0 && now - bypassArmedAt < CONFIRM_MS
    if (bypassArmedAt && !bypassArmed) bypassArmedAt = 0
    // Every bottom-row button is padded to one width so the brackets line up.
    const BTN = 8
    const framed = (key: string, label: string, action: string, color: string) =>
      bracket(els, { key, label, color, width: BTN, onPress: () => void actions[action]?.() })
    // Shown only when Settings → Dock → PERMISSIONS turns it on: red while it waits for its prompt or has switched.
    const bypassButton = showBypass
      ? framed('bypass-run', bypassArmed ? 'Yes?' : bypassWanted ? 'Bypass…' : 'Bypass', 'bypass', bypassArmed || bypassWanted || permissionMode === 'bypass' ? 'error' : colorOf(look.uiColor))
      : null
    const chip = (key: string, label: string, lit: boolean, color: string, press: () => void) =>
      bracket(els, { key, label, color, lit, onPress: press })
    const orange = (key: string, label: string, press: () => void) => bracket(els, { key, label, color: colorOf(look.uiColor), onPress: press })
    // The engine shows its own thinking line above the dock, so the rule stays plain.
    // One column short of the band and never wrapping, so the rule cannot spill into an extra row. Drawn
    // in the chosen style and colour; alternating colours in pairs of cells when patterned; a bright
    // window sweeping along it when shimmering.
    const Rule = () => {
      const width = Math.max(10, columns - 1)
      const glyph = RULE_STYLES[look.ruleStyle]?.id ?? '─'
      const base = colorOf(look.ruleColor)
      const alt = colorOf(look.ruleAltColor)
      // The shimmer is a wave: a bright crest racing along the line with a long tail fading behind it.
      // Near the crest the thin and thick lines also swell into a ridge.
      const TAIL = 18
      const head = look.ruleShimmer ? ((ruleFrame * 5) % (width + TAIL + 8)) - 4 : -1000
      const wavy = glyph === '─' || glyph === '━'
      const cellOf = (x: number): { ch: string; c: string; b: boolean } => {
        const behind = head - x // how far behind the crest this cell is
        const plain = look.rulePattern && Math.floor(x / 2) % 2 === 1 ? alt : base
        if (behind < -1 || behind > TAIL) return { ch: glyph, c: plain, b: false }
        if (behind <= 1) return { ch: wavy ? '▀' : glyph, c: 'text', b: true }
        if (behind <= 5) return { ch: wavy ? '━' : glyph, c: 'text', b: false }
        if (behind <= 11) return { ch: wavy ? '━' : glyph, c: plain, b: true }
        return { ch: glyph, c: plain, b: false }
      }
      const segs: { t: string; c: string; b: boolean }[] = []
      for (let x = 0; x < width; x += 1) {
        const cell = cellOf(x)
        const last = segs[segs.length - 1]
        if (last && last.c === cell.c && last.b === cell.b) last.t += cell.ch
        else segs.push({ t: cell.ch, c: cell.c, b: cell.b })
      }
      return (
        <Box flexDirection="row">
          {segs.map((sg, i) => <Text key={`rl${i}`} color={sg.c} bold={sg.b} wrap="truncate-end">{sg.t}</Text>)}
        </Box>
      )
    }

    const window = context?.window ?? 0

    // Plan windows: the usage endpoint when it answered, else the headers the last response carried.
    const limits = currentLimits()

    const title = [plan?.tier || tier, headline(limits, now)].filter(Boolean).join(' · ') || 'Usage'
    const age = plan ? Math.max(0, Math.round((now - plan.fetchedAt) / 1000)) : 0
    // Without an endpoint reading the bars come from the last response's headers, so there is nothing to call loading.
    const freshness = plan ? `updated ${age < 5 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`}` : limits.length ? '' : 'loading'
    // Endpoint hiccups retry on their own and stay out of the dock; only a missing login is worth saying.
    const planNote = ['usage windows on your subscription', freshness, planError === 'not signed in' ? planError : ''].filter(Boolean).join(' · ')
    const LABEL = 14
    const Label = ({ text }: { text: string }) => (
      <Text color="text">{text.padEnd(LABEL)}</Text>
    )
    // The chevron folds the section's rows away; the header stays so it can be unfolded.
    const Section = ({ text, note, which, open }: { text: string; note?: string; which: 'plan' | 'chat'; open: boolean }) => (
      <Box flexDirection="row" columnGap={1}>
        <Button key={`fold-${which}`} label={text.padEnd(LABEL - 2)} plain onPress={() => void toggleSection($, which)} />
        <Text color={colorOf(look.uiColor)}>{open ? '▾' : '▸'}</Text>
        {note ? <Text dimColor wrap="truncate-end">{note}</Text> : null}
      </Box>
    )
    const Gap = () => <Text> </Text>

    const limitRows = limits.map(l => (
      <Box key={`lim-${l.kind}`} flexDirection="row" columnGap={1}>
        {l.kind === 'weekly_scoped' ? (
          <Box flexDirection="row">
            <Text color={colorOf(look.uiColor)}>{' └▸ '}</Text>
            <Text color="text">{l.label.padEnd(Math.max(0, LABEL - 4))}</Text>
          </Box>
        ) : (
          <Label text={l.label} />
        )}
        <Text color={barColor(l.percent)}>{bar(l.percent, barWidth)}</Text>
        <Text>{`${Math.round(l.percent)}%`.padStart(4)}</Text>
        <Text dimColor wrap="truncate-end">
          {l.dollars ? `$${Math.round(l.dollars.limit - l.dollars.used)} of $${l.dollars.limit} left · ` : ''}
          {resetText(l.resetsAt, now)}
        </Text>
      </Box>
    ))

    const mainPercent = context?.percent ?? (context?.tokens && window ? Math.round((context.tokens / window) * 100) : 0)
    const contextRow = (
      <Box key="ctx-main" flexDirection="row" columnGap={1}>
        <Button key="context-open" label={'Context'.padEnd(LABEL - 2)} plain onPress={() => void actions.context?.()} />
        <Text color={colorOf(look.uiColor)}>{view === 'context' ? '▾' : '▸'}</Text>
        <Text color={barColor(mainPercent)}>{bar(mainPercent, barWidth)}</Text>
        <Text>{`${mainPercent}%`.padStart(4)}</Text>
        <Text dimColor wrap="truncate-end">
          {context?.tokens !== undefined && window ? `${kTokens(context.tokens)} of ${kTokens(window)} tokens used` : 'no reading yet'}
          {cost ? ` · $${cost.usd.toFixed(2)} spent` : ''}
        </Text>
      </Box>
    )

    const modelRow = (
      <Box flexWrap="wrap" key="ctx-model" flexDirection="row" columnGap={1}>
        <Label text="Model" />
        <Text>{model || 'unknown'}</Text>
        {EFFORTS.map(o => {
          // While a level is on its way its chip shows the star with dark brackets; the lit chip is the one the engine holds.
          const busy = effortBusy?.level === o
          const lit = !effortBusy && o === (effortOverride || effort)
          return chip(`effort-${o}`, busy ? starLabel(o) : o, lit, EFFORT_COLOR[o], () => void setEffort($, o))
        })}
        <ui.Client key={ULTRA_ID} module="./chip.tsx" props={{ label: ultraBusy ? starLabel('ultracode') : 'ultracode', color: '#827dbd', glow: '#c8c4ff', lit: ultracode && !ultraBusy }} width={14} height={1} />
        {configNote ? <Text dimColor wrap="truncate-end">· {configNote}</Text> : null}
      </Box>
    )

    const running = Math.max([...shells.values()].filter(x => x.endedAt === undefined).length, engineShells)
    const finished = shells.size - running
    const planSummary = limits.length > 0 ? limits.map(l => `${l.label} ${Math.round(l.percent)}%`).join(' · ') : 'no plan reading yet'
    const chatSummary = `${model ? `${model} · ` : ''}Context ${mainPercent}%${fastMode ? ' · FAST' : ''}`
    const planBody = planOpen ? Math.max(1, limitRows.length) : 0
    const chatBody = chatOpen ? 2 : 0
    const dashRows = 1 + 1 + 1 + planBody + 1 + 1 + chatBody + 1 + 1 + 1 + 1
    // Orange brackets, bold counts, plain words; the word is the pressable part.
    const badge = (
      <Box key="sh-badge-wrap" flexDirection="row">
        <Text bold color="text">{`${running} `}</Text>
        <Text dimColor>{finished > 0 ? 'running · ' : 'running'}</Text>
        {finished > 0 ? <Text bold color="text">{`${finished} `}</Text> : null}
        {finished > 0 ? <Text dimColor>just finished</Text> : null}
      </Box>
    )

    if (view === 'fast') {
      // The Fast page in the dock: state, what fast mode is, /fast's last word, and the switch. The switch
      // runs /fast as typed, whose one-line answer the engine writes to the transcript; nothing quieter exists.
      const pulse = fastMode ? (frame % 2 === 0 ? 'warning' : 'claude') : 'inactive'
      return (
        <Box flexDirection="column">
          <Rule />
          <Box flexDirection="row" columnGap={2}>
            <Button key="fast-title" label="Fast mode" plain onPress={() => { view = 'dash'; redraw($) }} />
            <Text color={colorOf(look.uiColor)}>▾</Text>
            <Text bold color={pulse}>{fastMode ? 'ON' : 'OFF'}</Text>
            {bracket(els, { key: 'fast-run', label: fastMode ? 'Turn off' : 'Turn on', color: 'warning', onPress: () => void toggleFast($) })}
            {fastNote ? <Text dimColor>· {fastNote}</Text> : null}
          </Box>
          <Text> </Text>
          <Text>High-speed output from the same model, drawn from usage credits at a higher rate; separate rate limits apply.</Text>
          <Text dimColor>Needs usage credits on for your plan (/usage-credits) · https://code.claude.com/docs/en/fast-mode</Text>
          <Text> </Text>
        </Box>
      )
    }

    if (view === 'context') {
      // The /context grid and its legend, drawn from the engine's own breakdown in the engine's colours.
      const b = breakdown
      const pct = b ? b.percentage : mainPercent
      const home = (
        orange('ctx-home', 'Dashboard', () => { view = 'dash'; redraw($) })
      )
      const legend = b
        ? b.categories.map(c => (
            <Box key={`cl-${c.name}`} flexDirection="row" columnGap={1}>
              <Text color={c.color} dimColor={c.kind === 'free'}>{c.kind === 'free' ? '⛶' : c.kind === 'deferred' ? '○' : '⛁'}</Text>
              <Text color="text">{`${c.name}:`}</Text>
              <Text dimColor>{c.kind === 'deferred' ? `${kTokens(c.tokens)} tokens (loaded on demand)` : `${kTokens(c.tokens)} tokens (${((c.tokens / Math.max(1, b.rawMaxTokens)) * 100).toFixed(1)}%)`}</Text>
            </Box>
          ))
        : []
      const grid = b
        ? b.gridRows.map((row, i) => (
            <Box key={`g-${i}`} flexDirection="row">
              {row.map((sq, j) => (
                <Text key={`g-${i}-${j}`} color={sq.color} dimColor={!sq.isFilled}>{sq.isFilled ? '⛁ ' : '⛶ '}</Text>
              ))}
            </Box>
          ))
        : [<Text key="g-none" dimColor>{breakdownNote || 'counting…'}</Text>]
      const gridWidth = b ? Math.max(10, (b.gridRows[0]?.length ?? 10) * 2) : 22
      return (
        <Box flexDirection="column">
          <Rule />
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Button key="ctx-title" label="Context Usage" plain onPress={() => { view = 'dash'; redraw($) }} />
            <Text color={colorOf(look.uiColor)}>▾</Text>
            {home}
            {orange('ctx-recount', breakdownBusy ? 'Counting…' : 'Recount', () => void loadBreakdown($, columns))}
            {framed('compact-run', compactArmed ? 'Yes?' : 'Compact', 'compact', compactArmed ? 'error' : colorOf(look.uiColor))}
{bypassButton}
{bypassNote ? <Text dimColor>· {bypassNote}</Text> : null}
{compactNote ? <Text dimColor>· {compactNote}</Text> : null}
            {breakdownNote && b ? <Text dimColor>· {breakdownNote}</Text> : null}
          </Box>
          <Box flexDirection="row" columnGap={2}>
            <Box flexDirection="column" width={gridWidth}>{grid}</Box>
            <Box flexDirection="column">
              <Text color="text">{b ? b.model : model || 'unknown'}</Text>
              {b && model && b.model !== model ? <Text dimColor>{model}</Text> : null}
              <Text dimColor>{b ? `${kTokens(b.totalTokens)}/${kTokens(b.rawMaxTokens)} tokens (${Math.round(pct)}%)` : context?.tokens !== undefined && window ? `${kTokens(context.tokens)}/${kTokens(window)} tokens (${mainPercent}%)` : 'no reading yet'}</Text>
              <Text> </Text>
              <Text dimColor italic>Estimated usage by category</Text>
              {legend}
              {b && b.autoCompactThreshold ? <Text dimColor>auto-compacts at {kTokens(b.autoCompactThreshold)}</Text> : null}
            </Box>
          </Box>
          <Text> </Text>
        </Box>
      )
    }

    if (view === 'shells') {
      // The shells page takes exactly the dashboard's height, so the band never jumps between the two.
      const pageRows = Math.max(dashRows, 6)
      let roomLeft = pageRows - 2 - shells.size
      const shellRows: ReturnType<typeof Box>[] = []
      for (const s of shells.values()) {
        const isOpen = expanded.has(s.toolUseId)
        const mark = s.endedAt !== undefined ? (s.failed ? '✗' : '✓') : s.taskId ? '⇡' : '▶'
        const markColor = s.endedAt !== undefined ? (s.failed ? 'error' : 'success') : s.taskId ? 'ide' : 'warning'
        const when = s.endedAt !== undefined ? `${s.failed ? 'failed' : 'done'} in ${elapsed(s.startedAt, s.endedAt)}` : elapsed(s.startedAt, now)
        shellRows.push(
          <Box key={`sh-${s.toolUseId}`} flexDirection="row" columnGap={1}>
            {orange(`sh-toggle-${s.toolUseId}`, isOpen ? '−' : '+', () => {
              if (isOpen) expanded.delete(s.toolUseId)
              else expanded.add(s.toolUseId)
              redraw($)
            })}
            <Text color={markColor}>{mark}</Text>
            <Text color="text" dimColor={s.endedAt !== undefined} wrap="truncate-end">{s.description}</Text>
            <Text dimColor>{when}{s.agentId ? ' · subagent' : ''}</Text>
          </Box>,
        )
        if (isOpen && roomLeft > 1) {
          const lines = Math.max(1, roomLeft - 1)
          const tail = s.taskId ? await tailOutput($, s.taskId, lines, columns - 6) : []
          const used = 1 + Math.max(1, tail.length)
          roomLeft -= used
          shellRows.push(
            <Box key={`sh-body-${s.toolUseId}`} flexDirection="column" paddingLeft={4}>
              <Text dimColor wrap="truncate-end">$ {s.command.replace(/\s+/g, ' ')}</Text>
              {tail.length > 0 ? (
                tail.map((line, i) => <Text key={`sh-out-${s.toolUseId}-${i}`}>{line}</Text>)
              ) : (
                <Text dimColor>
                  {s.endedAt !== undefined
                    ? 'finished; its output is in the transcript'
                    : s.taskId
                      ? 'no output yet'
                      : 'running in the foreground; output arrives when it finishes'}
                </Text>
              )}
            </Box>,
          )
        }
      }
      const filler = Math.max(0, roomLeft)
      return (
        <Box flexDirection="column">
          <Rule />
          <Box flexDirection="row" columnGap={2}>
            <Button key="shells-close" label="SHELLS" plain onPress={() => { view = 'dash'; redraw($) }} />
            <Text color={colorOf(look.uiColor)}>▾</Text>
            {badge}
            <Text dimColor>{shells.size > 0 ? "press a shell to open or close it · press the badge to return" : 'none running · press the badge to return'}</Text>
          </Box>
          {shellRows}
          {Array.from({ length: filler }, (_, i) => <Text key={`fill-${i}`}> </Text>)}
        </Box>
      )
    }

    const pose = DANCE[frame] ?? DANCE[0]!
    // Talking, he stands still until the words fade.
    const shownPose = bubble ? DANCE[0]! : pose
    // While the chase runs it has the whole band to itself, from the mascot's own column rightward.
    const stage = scene ? snakeFrame(scene.t, Math.max(40, columns), SHIRTS[shirt] ?? 'claude') : null
    if (scene && !stage) scene = null
    // A comic bubble above the mascot, its text wrapped to the column, tail pointing down at it.
    const inner = mascotWidth - 2
    const words = bubble.split(' ')
    const wrapped: string[] = []
    // "compacting" is a column wider than the wrap, so its moving dots hang on a line beneath it.
    if (compacting && bubble.startsWith('compacting')) wrapped.push('compacting', bubble.slice('compacting'.length))
    else {
      for (const w of words) {
        const last = wrapped[wrapped.length - 1]
        if (last !== undefined && `${last} ${w}`.length <= inner) wrapped[wrapped.length - 1] = `${last} ${w}`
        else wrapped.push(w.slice(0, inner))
      }
    }
    // A dashed bubble with the words centred in it.
    const centre = (l: string) => {
      const gap = Math.max(0, inner - l.length)
      const left = Math.floor(gap / 2)
      return ' '.repeat(left) + l + ' '.repeat(gap - left)
    }
    // Floating words above the mascot, centred, with a blank line between them and his head.
    const bubbleLines = bubble ? [...wrapped.slice(0, 3).map(centre), ' '] : []
    if (slim) {
      return (
        <Box flexDirection="column">
          <Rule />
          <Box flexDirection="row" columnGap={2} minHeight={look.avatar ? pose.length + 1 : 2} paddingTop={1} alignItems="center">
            {look.avatar ? (
              <Box flexDirection="column" width={mascotWidth} flexShrink={0} alignItems="center" height={pose.length}>
                {pose.map((line, i) =>
                  i === 0 && ultracode ? (
                    <Box key={`m${i}`} flexDirection="row">
                      <Text color={ULTRA}>{line}</Text>
                      <Text color={SPARK}>/✦</Text>
                    </Box>
                  ) : (
                    <Text key={`m${i}`} color={ultracode ? ULTRA : i === 1 ? SHIRTS[shirt] ?? 'claude' : 'claude'}>{line}</Text>
                  ),
                )}
              </Box>
            ) : null}
            <Box flexDirection="row" columnGap={1} flexWrap="wrap" paddingLeft={look.avatar ? 0 : 1}>
              {framed('config-open', 'Settings', 'config', colorOf(look.uiColor))}
              {fastMode
                ? <ui.Client key={`${FAST_CHIP_ID}-slim`} module="./chip.tsx" props={{ label: 'FAST', color: 'warning', glow: '#fff3a0', lit: true, width: BTN, bracketColor: colorOf(look.uiColor) }} width={BTN + 4} height={1} />
                : framed('fast-toggle', fastMode ? 'FAST' : 'Fast', 'fast', colorOf(look.uiColor))}
              {framed('compact-run', compactArmed ? 'Yes?' : 'Compact', 'compact', compactArmed ? 'error' : colorOf(look.uiColor))}
{bypassButton}
{bypassNote ? <Text dimColor>· {bypassNote}</Text> : null}
{compactNote ? <Text dimColor>· {compactNote}</Text> : null}
              {framed('slim-toggle', 'Bulk', 'slim', colorOf(look.uiColor))}
            </Box>
          </Box>
        </Box>
      )
    }
    if (stage) {
      // The chase has the band to itself: no title, just the rule and the stage.
      return (
        <Box flexDirection="column">
          <Rule />
          {stage.map((row, i) => (
            <Box key={`sc${i}`} flexDirection="row">
              {row.map((seg, j) => <Text key={`sc${i}-${j}`} color={seg.c}>{seg.t}</Text>)}
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Rule />
        <Box flexDirection="row" columnGap={2} paddingLeft={look.avatar ? 0 : 1}>
        {!look.avatar ? null : (
          <ui.Client key={MASCOT_ID} module="./mascot.tsx" props={{ pose: [...shownPose], bubble: bubbleLines, color: SHIRTS[shirt] ?? 'claude', climb, climbAt, rows: dashRows, leanPoses: [[...DANCE[2]!], [...DANCE[6]!]], dancePoses: DANCE.map(d => [...d]), react, ultra: ultracode, talk, bubbleColor: bubble.trim() === '♥' ? PINK : 'text' }} width={mascotWidth} height="100%" />
        )}
        <Box flexDirection="column" flexGrow={1}>
          {look.header ? (
            <Box flexDirection="row" columnGap={2}>
              <Text bold color={colorOf(look.uiColor)}>{title}</Text>
              {usageNote ? <Text dimColor>· {usageNote}</Text> : null}
            </Box>
          ) : (
            <Text> </Text>
          )}
          <Gap />
          <Section text="PLAN" which="plan" open={planOpen} note={planOpen ? planNote : planSummary} />
          {planOpen ? (limitRows.length > 0 ? limitRows : <Text dimColor>no plan reading yet</Text>) : null}
          <Gap />
          <Section text="THIS CHAT" which="chat" open={chatOpen} note={chatOpen ? 'context window of this conversation' : chatSummary} />
          {chatOpen ? contextRow : null}
          {chatOpen ? modelRow : null}
          <Gap />
          <Box flexDirection="row" columnGap={1}>
            <Button key="shells-open" label={'SHELLS'.padEnd(LABEL - 2)} plain onPress={() => { view = 'shells'; redraw($) }} />
            <Text color={colorOf(look.uiColor)}>▸</Text>
            {badge}
          </Box>
          <Gap />
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            {framed('config-open', 'Settings', 'config', colorOf(look.uiColor))}
            {fastMode
              ? <ui.Client key={FAST_CHIP_ID} module="./chip.tsx" props={{ label: 'FAST', color: 'warning', glow: '#fff3a0', lit: true, width: BTN, bracketColor: colorOf(look.uiColor) }} width={BTN + 4} height={1} />
              : framed('fast-toggle', fastMode ? 'FAST' : 'Fast', 'fast', colorOf(look.uiColor))}
            {framed('compact-run', compactArmed ? 'Yes?' : 'Compact', 'compact', compactArmed ? 'error' : colorOf(look.uiColor))}
{bypassButton}
{bypassNote ? <Text dimColor>· {bypassNote}</Text> : null}
{compactNote ? <Text dimColor>· {compactNote}</Text> : null}
            {framed('slim-toggle', 'Slim', 'slim', colorOf(look.uiColor))}
            {fastNote ? <Text dimColor>· fast {fastNote}</Text> : null}
          </Box>
        </Box>
        </Box>
      </Box>
    )
  })
  // The Usage pane: what /usage shows, drawn from the dock's own live reading, open at once mid-turn.

  // The Config pane: the /config menu as the engine lists it, to read. Changes go through /config itself.
  on('ui.render', { component: 'Pane', requestId: CONFIG_PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const els = { Box, Text, Button }
    const now = await $.clock.now()
    const paneRows = Number.isFinite(e.props.scroll.bodyRows) ? e.props.scroll.bodyRows : 30
    const menuTabs = CONFIG_TABS.map(t => ({ id: t.id, label: t.label }))
    const info = (id: string, label: string, value: string): MenuRow => ({ id, label, value, action: 'none' })

    // Every tab is drawn by the same keyboard list (read-only rows where nothing can change), so the
    // list keeps the keyboard and the tab cursor when Enter switches tabs.
    let menuRows: MenuRow[] = []
    let hint = ''
    let labelWidth = 30
    let configRows: ConfigRow[] = []
    let statsLines: Seg[][] = []

    if (configTab === 'config') {
      try {
        configRows = await $.config.list()
      } catch {
        configRows = []
      }
      labelWidth = Math.min(52, Math.max(12, ...configRows.map(r => r.label.length)) + 8)
      menuRows = configRows.map(r => {
        const shown = Array.isArray(r.value) ? r.value.join(', ') : String(r.value)
        const row: MenuRow = { id: r.key, label: r.label, value: shown, action: 'none' }
        if (r.isLocked) row.muted = true
        if (r.isLocked && r.description) row.note = r.description
        return row
      })
      hint = `${configRows.length} settings, as /config lists them · change them with /config · ↑↓ move · ↑ past the top reaches the tabs · esc closes`
    } else if (configTab === 'dock') {
      // The mod's own look: every row steps with ←→ and is kept in the store.
      const cyc = (id: string, label: string, value: string): MenuRow => ({ id, label, value, action: 'cycle' })
      const tog = (id: string, label: string, lit: boolean): MenuRow => ({ id, label, value: lit ? 'on' : 'off', action: 'toggle' })
      const head = (id: string, label: string): MenuRow => ({ id, label, value: '', action: 'none', heading: true })
      // A blank heading row before each group after the first keeps the groups apart.
      const gap = (id: string): MenuRow => ({ id, label: '', value: '', action: 'none', heading: true })
      labelWidth = 26
      menuRows = [
        head('dock-h-header', 'HEADER'),
        tog('dock-header', 'Show the plan headline', look.header),
        gap('dock-g1'),
        head('dock-h-line', 'TOP LINE'),
        cyc('dock-rule-color', 'Colour', COLORS[look.ruleColor]?.name ?? 'white'),
        cyc('dock-rule-style', 'Style', `${RULE_STYLES[look.ruleStyle]?.name ?? 'thin'}  ${(RULE_STYLES[look.ruleStyle]?.id ?? '─').repeat(6)}`),
        tog('dock-rule-shimmer', 'Shimmer', look.ruleShimmer),
        tog('dock-rule-pattern', 'Alternating colours', look.rulePattern),
        cyc('dock-rule-alt', 'Second colour', COLORS[look.ruleAltColor]?.name ?? 'orange'),
        gap('dock-g2'),
        head('dock-h-avatar', 'AVATAR'),
        tog('dock-avatar', 'Show the avatar', look.avatar),
        cyc('dock-shirt', 'Shirt', COLORS.find(c => c.id === SHIRTS[shirt])?.name ?? 'orange'),
        gap('dock-g3'),
        head('dock-h-menu', 'UI'),
        cyc('dock-ui-color', 'Theme', COLORS[look.uiColor]?.name ?? 'orange'),
        gap('dock-g4'),
        head('dock-h-perm', 'PERMISSIONS'),
        tog('dock-show-bypass', 'Show the Bypass button', showBypass),
        gap('dock-g4b'),
        head('dock-h-shells', 'SHELLS'),
        tog('dock-auto-bg', 'Background servers and watchers', autoBackground),
        gap('dock-g5'),
        head('dock-h-sound', 'SOUND'),
        tog('dock-snd-notify', 'Notifications', sounds.notify),
        cyc('dock-snd-done', 'When Claude finishes', soundName(sounds.done)),
        cyc('dock-snd-needs', 'When Claude needs you', soundName(sounds.needs)),
        cyc('dock-snd-agent', 'When a subagent finishes', soundName(sounds.agent)),
        cyc('dock-snd-volume', 'Volume', `${Math.round((VOLUMES[sounds.volume] ?? 0.5) * 100)}%`),
        tog('dock-idle-voice', 'Robot voice', sounds.voice),
      ]
      hint = 'the dock\'s own look · ←→ change · saved for every session · esc closes'
    } else if (configTab === 'settings') {
      // ~/.claude/settings.json as an indented key tree: objects as headings, one row per value, booleans
      // steppable with ←→ (written back to the file), env values never shown.
      let settings: Record<string, unknown> = {}
      let where = ''
      try {
        const home = (await $.env.get('HOME')) ?? ''
        where = `${home}/.claude/settings.json`
        settings = JSON.parse(await $.fs.read(where)) as Record<string, unknown>
      } catch {
        settings = {}
      }
      const rowsOut: MenuRow[] = []
      // Only a value whose name says it is a credential is masked; everything else shows as it is.
      const secretName = (k: string) => /key|token|secret|password|passwd|credential|auth/i.test(k)
      const walk = (o: unknown, depth: number, path: string[]) => {
        const entries = Array.isArray(o) ? o.map((v, i) => [`[${i}]`, v] as const) : Object.entries(o as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y))
        for (const [k, v] of entries) {
          const label = `${' '.repeat(depth * 2)}${k}`
          const id = `set:${[...path, k].join('.')}`
          if (v && typeof v === 'object') {
            // A blank row keeps each top-level group apart.
            if (depth === 0 && rowsOut.length > 0) rowsOut.push({ id: `${id}:gap`, label: '', value: '', action: 'none', heading: true })
            rowsOut.push({ id, label, value: '', action: 'none', heading: true })
            walk(v, depth + 1, [...path, k])
          } else if (secretName(k)) rowsOut.push({ id, label, value: '••••', action: 'none', muted: true })
          else rowsOut.push({ id, label, value: String(v), action: 'none' })
        }
      }
      walk(settings, 0, [])
      labelWidth = Math.min(48, Math.max(12, ...rowsOut.map(r => r.label.length)) + 6)
      menuRows = rowsOut
      hint = `${Object.keys(settings).length} keys in ${where.replace(/^.*\/\.claude\//, '~/.claude/')} · to read · ↑↓ move · esc closes`
    } else if (configTab === 'status') {
      let id = '', cwd = '', version = '', surface = ''
      try {
        id = await $.session.id()
        cwd = await $.session.cwd()
        version = (await $.session.version()).version
        surface = (await $.session.surface()) ?? ''
      } catch {
        // partial status is still status
      }
      // This session's record (~/.claude/sessions/<pid>.json): its name, kind and messaging socket.
      let record: { name?: string; kind?: string; messagingSocketPath?: string; entrypoint?: string } = {}
      // The signed-in account (~/.claude.json → oauthAccount): shown as /status shows it, never tokens.
      let account: { emailAddress?: string; organizationName?: string; organizationType?: string; billingType?: string } = {}
      const sources: string[] = []
      try {
        const home = (await $.env.get('HOME')) ?? ''
        for (const entry of await $.fs.list(`${home}/.claude/sessions`)) {
          if (!entry.name.endsWith('.json')) continue
          try {
            const rec = JSON.parse(await $.fs.read(`${home}/.claude/sessions/${entry.name}`)) as { sessionId?: string } & typeof record
            if (rec.sessionId === id) {
              record = rec
              break
            }
          } catch {
            // not a record
          }
        }
        try {
          const root = JSON.parse(await $.fs.read(`${home}/.claude.json`)) as { oauthAccount?: typeof account }
          account = root.oauthAccount ?? {}
        } catch {
          account = {}
        }
        if (await $.fs.exists(`${home}/.claude/settings.json`)) sources.push('User settings')
        if (cwd && (await $.fs.exists(`${cwd}/.claude/settings.json`))) sources.push('Shared project settings')
        if (cwd && (await $.fs.exists(`${cwd}/.claude/settings.local.json`))) sources.push('Project local settings')
      } catch {
        // no files, no sources
      }
      let mcpCount = 0
      try {
        const names = new Set<string>()
        for (const t of await $.tool.list()) if (t.mcp) names.add(/^mcp__(.+?)__/.exec(t.name)?.[1] ?? 'mcp')
        mcpCount = names.size
      } catch {
        mcpCount = 0
      }
      const kind = record.kind === 'bg' ? 'background job' : record.kind === 'interactive' ? 'interactive' : record.kind ?? surface ?? 'session'
      const login = account.organizationType === 'claude_max' ? 'Claude Max account' : account.organizationType === 'claude_pro' ? 'Claude Pro account' : account.billingType ? `${account.billingType} account` : plan?.tier || tier || 'unknown'
      // Drawn as coloured lines, as /status draws them: bold labels, plain values, counts in their colours.
      const W = 18
      const line = (label: string, ...value: Seg[]): Seg[] => [{ t: `${label}:`.padEnd(W), c: 'text', b: true }, ...value]
      const plain = (label: string, v: string) => line(label, { t: v, c: 'text' })
      statsLines = [
        plain('Version', version || 'unknown'),
        ...(record.name ? [plain('Session name', record.name)] : []),
        plain('Session ID', id || 'unknown'),
        plain('Session kind', `${kind}${record.entrypoint ? ` · ${record.entrypoint}` : ''}`),
        ...(record.messagingSocketPath ? [plain('Peer address', `uds:${record.messagingSocketPath}`)] : []),
        plain('cwd', cwd || 'unknown'),
        [],
        plain('Login method', login),
        ...(account.organizationName ? [plain('Organization', account.organizationName)] : []),
        ...(account.emailAddress ? [plain('Email', account.emailAddress)] : []),
        [],
        line('Permissions', permissionMode ? { t: permissionMode, c: permissionMode === 'bypass' ? 'error' : 'text' } : { t: 'read from the footer once it draws', d: true }),
        line('Model', { t: model || 'unknown', c: 'text' }, ...(effort ? [{ t: ` · ${effort} effort`, d: true }] : []), ...(effortOverride ? [{ t: ' · set from the dock', d: true }] : [])),
        line('MCP servers', { t: `${mcpCount} connected`, c: 'success' }, { t: ' · /mcp', d: true }),
        plain('Setting sources', sources.join(', ') || 'none found'),
        line('Fast mode', fastMode ? { t: 'on', c: 'warning' } : { t: fastReply ? 'off' : 'unknown until /fast answers', d: true }),
        line('Ultracode', ultracode ? { t: 'on', c: '#827dbd' } : { t: 'off', d: true }),
      ]
      labelWidth = W
      menuRows = []
      hint = 'what /status shows · esc closes'
    } else if (configTab === 'usage') {
      const limits = currentLimits()
      const barWidth = Math.max(16, Math.min(40, Math.floor(e.props.bodyColumns / 3)))
      const age = plan ? Math.max(0, Math.round((now - plan.fetchedAt) / 1000)) : 0
      const W = 24
      const row = (label: string, ...value: Seg[]): Seg[] => [{ t: `${label}:`.padEnd(W), d: true }, ...value]
      const dim = (t: string): Seg => ({ t, d: true })
      const lines: Seg[][] = [[{ t: 'Session', c: 'text', b: true }], []]
      lines.push(row('Total cost', dim(cost ? `$${cost.usd.toFixed(2)}` : 'unknown')))
      lines.push(row('Total duration (wall)', dim(sessionStartedAt ? duration(now - sessionStartedAt) : 'unknown')))
      lines.push(row('Total duration (API)', dim(apiMs ? `${duration(apiMs)} since the dock loaded` : 'counted from the dock\'s load on')))
      lines.push([dim('Usage by model:'.padEnd(W)), dim(tally.size ? '' : 'turns since the dock loaded; none yet')])
      const names = [...tally.keys()].sort((x, y) => (tally.get(y)!.output - tally.get(x)!.output))
      const nameWidth = Math.max(0, ...names.map(n => n.length)) + 1
      for (const n of names) {
        const t = tally.get(n)!
        lines.push([{ t: `${`${n}:`.padStart(nameWidth + 1)}  `, d: true }, dim(`${bigNumber(t.input)} input, ${bigNumber(t.output)} output, ${bigNumber(t.cacheRead)} cache read, ${bigNumber(t.cacheWrite)} cache write`)])
      }
      const main = tally.get(model)
      if (main) {
        const denom = main.input + main.cacheRead + main.cacheWrite
        const share = denom ? Math.round((main.cacheRead / denom) * 100) : 0
        lines.push(row('Prompt cache (main)', dim(`${requests} requests · ${share}% of input tokens from cache`)))
      }
      lines.push([])
      // The plan windows as /usage names them, one bar each in the engine's lavender.
      const windowName = (l: Limit): string => {
        const k = l.kind.toLowerCase()
        if (k === 'session' || k === 'five_hour') return 'Current session'
        if (k === 'weekly_all' || k === 'seven_day') return 'Current week (all models)'
        if (k === 'weekly_scoped') return `Current week (${l.label})`
        return l.label
      }
      for (const l of limits) {
        const filled = Math.round((Math.min(100, Math.max(0, l.percent)) / 100) * barWidth)
        lines.push([{ t: windowName(l), c: 'text', b: true }])
        lines.push([{ t: '█'.repeat(filled), c: 'permission' }, { t: '█'.repeat(barWidth - filled), d: true }, { t: ` ${Math.round(l.percent)}% used`, c: 'text' }])
        lines.push([dim([l.dollars ? `$${(l.dollars.limit - l.dollars.used).toFixed(2)} of $${l.dollars.limit.toFixed(0)} left` : '', resetText(l.resetsAt, now).replace(/^resets /, 'Resets ').replace(/^expires /, 'Expires ')].filter(Boolean).join(' · '))])
        lines.push([])
      }
      if (limits.length === 0) lines.push([dim('no usage reading yet')], [])
      lines.push([dim("What's contributing to your limits, and the subagent and MCP shares, are the engine's own analysis: /usage shows them.")])
      statsLines = lines
      labelWidth = W
      menuRows = []
      hint = plan ? `what /usage shows · updated ${age < 5 ? 'just now' : age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`} · esc closes` : 'what /usage shows · loading · esc closes'
    } else {
      let cache: StatsCache = {}
      try {
        const home = (await $.env.get('HOME')) ?? ''
        cache = JSON.parse(await $.fs.read(`${home}/.claude/stats-cache.json`)) as StatsCache
      } catch {
        cache = {}
      }
      statsLines = statsHeader(cache, now, statsPeriod, colorOf(look.uiColor))
      labelWidth = 12
      menuRows = [{ id: 'x-period', label: 'Period', value: PERIOD_LABEL[statsPeriod], action: 'cycle' }]
      hint = `what /stats shows · ${cache.totalMessages ? `${bigNumber(cache.totalMessages)} messages all time` : 'no stats cache yet'} · esc closes`
    }

    return (
      <Box flexDirection="column" paddingX={1} height={paneRows}>
        <ui.Client key={MENU_ID} module="./menu.tsx" props={{ rows: menuRows, labelWidth, tabs: menuTabs, activeTab: configTab, hint, header: statsLines, accent: colorOf(look.uiColor) }} width="100%" flexGrow={1} />
        {configNote ? <Text dimColor>{configNote}</Text> : null}
        {bracket(els, { key: 'config-close', label: 'Close', onPress: () => void $.ui.close({ id: CONFIG_PANE }) })}
      </Box>
    )
  })

  // A menu press names the row; the hooks module makes the change.
  on('ui.message', async ($, e, next) => {
    const switched = e.data as { select?: unknown } | null
    const data = e.data as { select?: unknown; dir?: unknown; tab?: unknown } | null
    // A click or key in the dock is someone at the keyboard; the mascot's own timing messages are not.
    const internal = e.element === MASCOT_ID && data !== null && ('talked' in data || 'done' in data)
    if (!internal) void noteActivity($)
    if (e.element === MENU_ID && data && typeof data.tab === 'string' && CONFIG_TABS.some(t => t.id === data.tab)) {
      configTab = data.tab as ConfigTab
      redraw($)
      return next(e)
    }
    if (e.element === MENU_ID && data && typeof data.select === 'string' && data.select.startsWith('dock-')) {
      const step = data.dir === 'prev' ? -1 : 1
      const wrap = (i: number, n: number) => (i + step + n) % n
      switch (data.select) {
        case 'dock-rule-color': look = { ...look, ruleColor: wrap(look.ruleColor, COLORS.length) }; break
        case 'dock-rule-style': look = { ...look, ruleStyle: wrap(look.ruleStyle, RULE_STYLES.length) }; break
        case 'dock-rule-shimmer': look = { ...look, ruleShimmer: !look.ruleShimmer }; break
        case 'dock-rule-pattern': look = { ...look, rulePattern: !look.rulePattern }; break
        case 'dock-rule-alt': look = { ...look, ruleAltColor: wrap(look.ruleAltColor, COLORS.length) }; break
        case 'dock-avatar': look = { ...look, avatar: !look.avatar }; break
        case 'dock-header': look = { ...look, header: !look.header }; break
        case 'dock-ui-color': look = { ...look, uiColor: wrap(look.uiColor, COLORS.length) }; break
        case 'dock-snd-done':
        case 'dock-snd-needs':
        case 'dock-snd-agent': {
          const moment = data.select.slice('dock-snd-'.length) as SoundMoment
          sounds = { ...sounds, [moment]: stepSound(sounds[moment], step) }
          playSound($, sounds[moment])
          save($, 'sounds', sounds)
          break
        }
        case 'dock-show-bypass': {
          showBypass = !showBypass
          if (!showBypass) bypassWanted = false
          save($, 'showBypass', showBypass)
          break
        }
        case 'dock-auto-bg': {
          autoBackground = !autoBackground
          save($, 'autoBackground', autoBackground)
          break
        }
        case 'dock-snd-notify': {
          sounds = { ...sounds, notify: !sounds.notify }
          if (sounds.notify) playSound($, sounds.done || sounds.needs || 'success')
          save($, 'sounds', sounds)
          break
        }
        case 'dock-idle-voice': {
          sounds = { ...sounds, voice: !sounds.voice }
          save($, 'sounds', sounds)
          break
        }
        case 'dock-snd-volume': {
          sounds = { ...sounds, volume: wrap(sounds.volume, VOLUMES.length) }
          playSound($, sounds.done || sounds.needs || 'success')
          save($, 'sounds', sounds)
          break
        }
        case 'dock-shirt': {
          shirt = wrap(shirt, SHIRTS.length)
          save($, 'shirt', shirt)
          break
        }
        default: break
      }
      // The change is drawn now; the write follows in the background.
      redraw($)
      save($, 'look', look)
      redraw($)
      return next(e)
    }
    if (e.element === MENU_ID && data && data.select === 'x-period') {
      const order: StatsPeriod[] = ['all', '30', '7']
      const i = order.indexOf(statsPeriod)
      statsPeriod = order[(i + (data.dir === 'prev' ? -1 : 1) + order.length) % order.length] ?? 'all'
      redraw($)
      return next(e)
    }
    if (e.element === MASCOT_ID && data) {
      const d = data as { tap?: unknown; done?: unknown; talked?: unknown }
      if (d.talked === true) {
        talk = null
        redraw($)
        return next(e)
      }
      if (d.done === true) {
        react = null
        redraw($)
        return next(e)
      }
      if (d.tap === true && !slim && !scene && !react) {
        // Only a burst of clicks does anything; a single click is left alone.
        const now = await $.clock.now()
        taps = [...taps.filter(t => now - t < TAP_WINDOW_MS), now]
        if (taps.length < TAP_BURST) return next(e)
        taps = []
        rollReaction()
        redraw($)
      }
      return next(e)
    }
    if ((e.element === FAST_CHIP_ID || e.element === `${FAST_CHIP_ID}-slim`) && data && (data as { press?: unknown }).press === true) {
      view = view === 'fast' ? 'dash' : 'fast'
      redraw($)
      return next(e)
    }
    if (e.element === ULTRA_ID && data && (data as { press?: unknown }).press === true) {
      await toggleUltracode($)
      return next(e)
    }
    return next(e)
  })

  // The Context pane: /context's grid and categories for this conversation, counted when opened or refreshed.
}
