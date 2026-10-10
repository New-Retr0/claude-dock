import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = {
  limits: [
    { kind: 'session', percent: 23, resets_at: '2026-10-07T02:30:00Z' },
    { kind: 'weekly_all', percent: 22, resets_at: '2026-10-12T05:00:00Z' },
    { kind: 'weekly_scoped', percent: 8, resets_at: '2026-10-12T05:00:00Z', scope: { model: { display_name: 'Fable' } } },
  ],
  iguana_necktie: { utilization: 92.3, resets_at: '2026-11-05T07:59:00Z', limit_dollars: 250, used_dollars: 230.8 },
  seven_day_breakdown: { rows: [{ key: 'claude_code', percent: 100 }] },
}

// How many usage reads the most recent bottom() has answered.
let usageReadCount = (): number => 0

// The model and effort the stubbed engine reports; a test may switch them, and bottom() puts them back.
const sessionModel = { id: 'claude-fable-5-1' }
const engineConfig = { effort: 'high' }

const BAND = {
  plugin: 'cc-dock',
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { bodyRows: 20, top: 0 },
    view: {},
  },
} as const


// The mascot draws inside its own Client; find it by key prefix to look inside.
const mascotIn = async (ui: { findAll: (q: never) => Promise<{ key?: string }[]> }) =>
  (await ui.findAll({ type: 'Client' } as never)).find(c => String(c.key).startsWith('mascot-'))?.key as string

// The spinner a chip shows while its switch is on the way, and a label with its padding taken off.
const STAR_GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽']
const bare = (label: string | undefined): string => (label ?? '').replace(/[\s ]/g, '')

// The clock fires at most 10000 timers per advance, and the 80 ms animation timer alone would exceed that over
// fifteen minutes, so long quiet stretches are walked in five-minute steps.
const quietFor = async (clock: { advance: (ms: number) => Promise<unknown> }, ms: number): Promise<void> => {
  for (let left = ms; left > 0; left -= 5 * 60_000) await clock.advance(Math.min(5 * 60_000, left))
}

const bottom = (on: On, usageStatus: number | readonly number[] = 200, start = 1_000_000) => {
  sessionModel.id = 'claude-fable-5-1'
  engineConfig.effort = 'high'
  const clock = mock.clock(on, { now: start })
  mock.store(on, {})
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  on('agent.list', () => ({ value: [] }) as never)
  on('session.model', () => ({ value: sessionModel.id }) as never)
  on('config.list', () => ({
    value: [
      { key: 'effort', label: 'Reasoning effort', kind: 'choice', value: engineConfig.effort, options: ['low', 'medium', 'high', 'xhigh', 'max'], provider: 'engine', isLocked: false },
      { key: 'fastMode', label: 'Fast mode', kind: 'boolean', value: true, provider: 'engine', isLocked: false },
    ],
  }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', rateLimitTier: 'default_claude_max_20x' } }), stderr: '' } }) as never)
  // A single status answers every read; a list answers the reads in turn, the last one repeating.
  let usageReads = 0
  usageReadCount = () => usageReads
  on('http.fetch', () => {
    usageReads += 1
    const status = typeof usageStatus === 'number' ? usageStatus : usageStatus[Math.min(usageReads, usageStatus.length) - 1]
    return { value: { status, ok: status === 200, headers: {}, text: status === 200 ? JSON.stringify(USAGE) : '' } } as never
  })
  return clock
}

test('without a usage reading the dock draws the windows the response headers carried', async ($, on) => {
  bottom(on, 503)
  on('session.measure', (_$, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-06T19:30:00-07:00' },
      { kind: 'seven_day', percentUsed: 22.4 },
    ],
    changed: ['context', 'rateLimits'],
  } as never)

  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Session/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /20%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /22%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /50k of 200k/ })).toBeDefined()
  await ui.unmount()
})

test('a backgrounded shell stays listed with its summary until it ends', async ($, on) => {
  const clock = bottom(on)
  on('tool.call', { tool: 'Bash' }, () => ({
    result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bg-1' },
  }) as never)
  on('classic.Stop', () => ({}) as never)

  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_sh', command: 'pnpm run dev', description: 'Start the dev server' } as never)

  let ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^1 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^running$/ })).toBeDefined()
  await ui.press({ key: 'shells-open' })
  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeUndefined()
  await ui.press({ key: 'shells-close' })
  await clock.advance(500)
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeDefined()
  await ui.unmount()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /^0 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^just finished$/ })).toBeDefined()
  await ui.press({ key: 'shells-open' })
  await clock.advance(500)
  expect(await ui.find({ type: 'Text', text: /done in/ })).toBeDefined()
  await ui.press({ key: 'shells-close' })
  await clock.advance(500)
  await ui.unmount()

  await clock.advance(25_000)
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^running$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^just finished$/ })).toBeUndefined()
  await ui.unmount()
})

test('a finished foreground shell is counted as just finished', async ($, on) => {
  bottom(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_ls', command: 'ls', description: 'List files' } as never)
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /^0 $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^just finished$/ })).toBeDefined()
  await ui.unmount()
})

test('after a session start the dock shows the plan tier and the Fable week, and no cloud credit', async ($, on) => {
  bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 259000, percent: 26 }, rateLimits: [], cost: { usd: 9.67 } } }) as never)

  await $.session.start({ cwd: '/tmp' } as never)

  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Max 20x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s*8%$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$19 of \$250 left|Cloud credit/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /THIS CHAT/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▐▛███▜▌/, in: await mascotIn(ui as never) } as never)).toBeDefined()
  await ui.unmount()
})

test('a bold rule spans the top of the dock', async ($, on) => {
  bottom(on)
  const ui = await $.ui.mount(BAND as never)
  const rule = await ui.find({ type: 'Text', text: /^─+$/ })
  expect(rule).toBeDefined()
  expect(rule?.text.length).toBe(99)
  await ui.unmount()
})

test('a busy usage endpoint keeps the plan tier in the header and says nothing about it', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ claudeAiOauth: { accessToken: 'test-token', rateLimitTier: 'default_claude_max_20x' } }), stderr: '' } }) as never)
  on('http.fetch', () => ({ value: { status: 429, ok: false, headers: {}, text: '' } }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1000000, tokens: 1000, percent: 0 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  mock.store(on, {})

  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()

  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /^Max 20x/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^plan:/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /busy|retrying|endpoint/ })).toBeUndefined()
  await ui.unmount()
})

test('reset times carry the time zone name', async ($, on) => {
  bottom(on, 503)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20, resetsAt: new Date(1_000_000 + 3_600_000).toISOString() }],
    changed: ['rateLimits'],
  } as never)
  const ui = await $.ui.mount(BAND as never)
  const row = await ui.find({ type: 'Text', text: /^resets \d{1,2}:\d{2} (AM|PM) [A-Z]{2,5}$/ })
  expect(row).toBeDefined()
  await ui.unmount()
})

test('the per-model week stays on screen when the usage endpoint is throttled after a turn', async ($, on) => {
  const clock = bottom(on, [200, 429])
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // The session's first reads come from the dock's own refresh: the first answers, the next is throttled.
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(6_000)
  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23 },
      { kind: 'seven_day', percentUsed: 22 },
    ],
    changed: ['rateLimits'],
  } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /^\s*8%$/ })).toBeDefined()
  await ui.unmount()
})

test('after a throttled usage read the dock waits before it asks again', async ($, on) => {
  const clock = bottom(on, [200, 429])
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  // The first read answers; the next, a minute on, is throttled.
  await clock.advance(70_000)
  expect(usageReadCount()).toBe(2)
  // Still inside the minute the endpoint asked for, the dock does not ask again.
  await clock.advance(40_000)
  expect(usageReadCount()).toBe(2)
  // Once the minute has passed it asks again.
  await clock.advance(30_000)
  expect(usageReadCount()).toBe(3)
})

test('a model response refreshes the usage reading live and the dock says how fresh it is', async ($, on) => {
  const clock = bottom(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }],
    changed: ['rateLimits'],
  } as never)
  await clock.settle()
  let ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /updated just now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /live ·/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Fable\s*$/ })).toBeDefined()
  await ui.unmount()

  await clock.advance(42_000)
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /updated (just now|\d+s ago)/ })).toBeDefined()
  await ui.unmount()
})

test('PLAN and THIS CHAT fold their rows away and remember it', async ($, on) => {
  const clock = bottom(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  await $.session.measure({
    context: { window: 200000, tokens: 50000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 20 }, { kind: 'seven_day', percentUsed: 22 }],
    changed: ['rateLimits'],
  } as never)
  let ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /▐▛███▜▌/, in: await mascotIn(ui as never) } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Session\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^Context\s*$/ })).toBeDefined()
  await ui.press({ key: 'fold-plan' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /^Session\s*$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\S.*\d+% · .*\d+%/ })).toBeDefined()
  await ui.press({ key: 'fold-chat' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Button', text: /^Context\s*$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /claude-fable-5-1 · Context 25%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▐▛███▜▌/, in: await mascotIn(ui as never) } as never)).toBeDefined()
  await ui.press({ key: 'fold-plan' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /^Session\s*$/ })).toBeDefined()
  // Folding and opening sections is not the ladder's cue: only Bulk is.
  const climbOf = async () => ((await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))?.props as { props?: { climb?: number } } | undefined)?.props?.climb
  await ui.press({ key: 'fold-chat' })
  await clock.advance(50)
  expect(await climbOf()).toBe(0)
  await ui.unmount()
})

test('Usage and Context open panes at once and Compact asks before it runs', async ($, on) => {
  const clock = bottom(on)
  const opened: string[] = []
  const runs: string[] = []
  let compacted = 0
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } } as never
  })
  on('command.run', (_$, e) => {
    runs.push(e.command)
    return { text: '' } as never
  })
  on('session.compact', () => {
    compacted += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  let ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'config-open' })
  await clock.advance(200)
  expect(opened).toEqual(['cc-dock-config'])
  expect(runs).toEqual([])

  await ui.press({ key: 'compact-run' })
  await clock.advance(200)
  expect(compacted).toBe(0)
  expect(await ui.find({ type: 'Button', text: /Yes\?/ })).toBeDefined()
  await clock.advance(7_000)
  await ui.unmount()
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Button', text: /Yes\?/ })).toBeUndefined()
  expect(compacted).toBe(0)

  await ui.press({ key: 'compact-run' })
  await clock.advance(200)
  await ui.press({ key: 'compact-run' })
  await clock.advance(200)
  expect(compacted).toBe(1)
  expect(runs).toEqual([])
  await ui.unmount()
})

test('the Config pane lists the settings to read, changes nothing, and Context flips the dock to the /context grid', async ($, on) => {
  const clock = bottom(on)
  on('tool.list', () => ({ value: [
    { name: 'mcp__github__search', description: '', mcp: true },
    { name: 'mcp__github__issues', description: '', mcp: true },
    { name: 'Bash', description: '', mcp: false },
  ] }) as never)
  const sets: unknown[] = []
  on('config.set', (_$, e) => {
    sets.push({ key: e.key, value: e.value })
    return { value: e.value } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', (_$, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200000, tokens: 50000, percent: 25,
        breakdown: e.breakdown ? {
          categories: [
            { name: 'System prompt', tokens: 12000, color: 'permission', isDeferred: false, kind: 'used' },
            { name: 'Messages', tokens: 38000, color: 'ide', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 150000, color: 'inactive', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 50000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'model', percentage: 25,
          gridRows: [[{ color: 'permission', isFilled: true }, { color: 'inactive', isFilled: false }]],
          model: 'Fable 5.1', memoryFiles: [{ path: '/x/MEMORY.md', type: 'user', tokens: 900 }], mcpTools: [], agents: [],
          isAutoCompactEnabled: true, apiUsage: null,
        } : undefined,
      },
      rateLimits: [], cost: { usd: 0 },
    },
  }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()

  const pane = (id: string) => ({ ...BAND, component: 'Pane', requestId: id, props: { title: id, isFocused: true, bodyColumns: 90, placement: 'dock', scroll: { offset: 0 }, view: {} } })

  let ui = await $.ui.mount(pane('cc-dock-config') as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  // The pane opens on Dock; ↑ to the tabs, → once and Enter reach Config.
  await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  await ui.key({ key: 'down', in: menuKey })
  expect(await ui.find({ type: 'Text', text: /^Reasoning effort/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^high$/, in: menuKey } as never)).toBeDefined()
  // Enter on the boolean row and ←→ on the choice row change nothing: settings change through /config.
  await ui.key({ key: 'down', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'left', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await clock.settle()
  expect(sets).toEqual([])
  expect(await ui.find({ type: 'Text', text: /change them with \/config/, in: menuKey } as never)).toBeDefined()
  // ↑ past the first row reaches the tab bar; → twice then Enter opens Usage.
  await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Current session$/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /% used$/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /press to open the shells page/ })).toBeUndefined()
  await ui.unmount()

  ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'context-open' })
  await clock.settle()
  expect(await ui.find({ type: 'Button', text: /^Context Usage/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Fable 5\.1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^System prompt:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Messages:/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^⛁ / })).toBeDefined()
  await ui.press({ key: 'ctx-home' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Button', text: /^Context Usage/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Max 20x/ })).toBeDefined()
  await ui.unmount()
})

test('the dock names the model and its effort, and leaves the thinking word to the engine', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>spin</Text>
  })
  on('turn.complete', () => ({ text: '' }) as never)
  const effortRuns: string[] = []
  on('command.run', (_$, e) => {
    effortRuns.push(`${e.command} ${e.args}`.trim())
    return { text: '' } as never
  })
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  let ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /claude-fable-5-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^\s*high\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^\s*low\s*$/ })).toBeDefined()
  // Pressing a level runs /effort low for the session at once when idle.
  await ui.press({ key: 'effort-low' })
  await clock.advance(500)
  await clock.advance(50)
  expect(effortRuns).toEqual(['effort low'])
  const stream = $.turn.step({ turnId: 't2', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 } as never)
  for await (const _chunk of stream) { /* drain */ }
  // /effort ran at once while idle, so the engine owns the level and the request carries its own.
  expect(seen).toEqual(['high'])
  expect(await ui.find({ type: 'Button', text: /^SHELLS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Hyperspacing/ })).toBeUndefined()
  await ui.unmount()

  const spinner = await $.ui.mount({
    plugin: 'cc-dock',
    surface: 'terminal',
    component: 'Spinner',
    requestId: 'spinner',
    props: { word: 'Hyperspacing', message: null, suffix: '…', mode: 'thinking' },
  } as never)
  await clock.advance(200)
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Hyperspacing…/ })).toBeUndefined()
  await ui.unmount()
  await spinner.unmount()

  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(200)
  ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /Hyperspacing/ })).toBeUndefined()
  await ui.unmount()
})

test('Compact pressed while a turn runs waits for the turn to end instead of queuing a prompt', async ($, on) => {
  const clock = bottom(on)
  const runs: string[] = []
  let compacted = 0
  let busy = true
  on('command.run', (_$, e) => {
    runs.push(e.command)
    return { text: '' } as never
  })
  on('session.compact', () => {
    if (busy) throw new Error('a turn is running')
    compacted += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  // A model request has started, so a turn is running.
  for await (const _c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'compact-run' })
  await clock.advance(200)
  await ui.press({ key: 'compact-run' })
  await clock.advance(200)
  expect(compacted).toBe(0)
  expect(runs).toEqual([])
  // The bubble wraps over lines, so the first word is what the avatar always shows.
  expect(await ui.find({ type: 'Text', text: /compacts/, in: await mascotIn(ui as never) } as never)).toBeDefined()
  busy = false
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1_000)
  expect(compacted).toBe(1)
  expect(runs).toEqual([])
  await ui.unmount()
})

test('the Fast page switches /fast when idle, refuses mid-turn, and trusts only the reply', async ($, on) => {
  const clock = bottom(on)
  on('turn.step', async function* (_$, e) { return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never })
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(e.command)
    return { text: 'Fast mode enabled' } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  const ui = await $.ui.mount(BAND as never)
    await ui.press({ key: 'fast-toggle' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /^OFF$/ })).toBeDefined()
  expect(runs).toEqual([])
  // Mid-turn the switch waits and runs once the turn ends.
  const step = $.turn.step({ turnId: 't9', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 } as never)
  for await (const _c of step) { /* drain */ }
  await ui.press({ key: 'fast-run' })
  await clock.advance(50)
  expect(runs).toEqual([])
  expect(await ui.find({ type: 'Text', text: /after this turn/ })).toBeDefined()
  await $.turn.complete({ turnId: 't9', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1_000)
  expect(runs).toEqual(['fast'])
  expect(await ui.find({ type: 'Text', text: /^ON$/ })).toBeDefined()
  await ui.unmount()
})

test('fast switch pressed idle runs /fast at once', async ($, on) => {
  const clock = bottom(on)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(e.command)
    return { text: 'Fast mode enabled' } as never
  })
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'fast-toggle' })
  await clock.advance(50)
  await ui.press({ key: 'fast-run' })
  await clock.advance(50)
  expect(runs).toEqual(['fast'])
  expect(await ui.find({ type: 'Text', text: /^ON$/ })).toBeDefined()
  await ui.press({ key: 'fast-title' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /^ON$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeDefined()
  await ui.unmount()
})

test('the Stats tab draws the activity grid and figures from the engine stats cache', async ($, on) => {
  const clock = bottom(on)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('fs.read', (_$, e) => ({
    value: String(e.path).endsWith('stats-cache.json')
      ? JSON.stringify({
          dailyActivity: [
            { date: '2026-10-05', messageCount: 120, sessionCount: 2, toolCallCount: 10 },
            { date: '2026-10-06', messageCount: 40, sessionCount: 1, toolCallCount: 3 },
          ],
          dailyModelTokens: [
            { date: '2026-10-05', tokensByModel: { 'claude-fable-5-1': 5_000_000 } },
            { date: '2026-10-06', tokensByModel: { 'claude-opus-5': 1_000_000 } },
          ],
          modelUsage: { 'claude-fable-5-1': { inputTokens: 1000, outputTokens: 2000, cacheReadInputTokens: 3000, cacheCreationInputTokens: 400 } },
          totalSessions: 3,
          totalMessages: 160,
          longestSession: { duration: 3_600_000 * 2, timestamp: '2026-10-05T10:00:00Z' },
          firstSessionDate: '2026-10-01T00:00:00Z',
        })
      : '{}',
  }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Config', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  // From Dock, ↑ reaches the tabs; four → presses land on Stats.
  await ui.key({ key: 'up', in: menuKey })
  for (let i = 0; i < 4; i += 1) await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^Favorite model: $/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /claude-fable-5-1/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^6\.0m/, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Mon /, in: menuKey } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Period/, in: menuKey } as never)).toBeDefined()
  await ui.unmount()
})

test('the mascot greets the signed-in person by first name, then the bubble fades', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('env.get', () => ({ value: '/home/test' }) as never)
  on('fs.read', (_$, e) => ({ value: String(e.path).endsWith('.claude.json') ? JSON.stringify({ oauthAccount: { displayName: 'Austin Lucero' } }) : '{}' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const mk = await mascotIn(ui as never)
  const texts = async () => (await ui.findAll({ type: 'Text', in: mk } as never)).map(x => x.text)
  expect((await texts()).some(x => /Austin|Hey\./.test(x))).toBe(true)
  await clock.advance(8_000)
  expect((await texts()).some(x => /Austin|Hey\./.test(x))).toBe(false)
  // A click hands the mascot a reaction, or starts the pie scene.
  const reactOf = async () => ((await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))?.props as { props?: { react?: { kind: string; id: number } | null } } | undefined)?.props?.react
  expect(await reactOf()).toBe(null)
  // One click does nothing; a burst of four within two seconds rolls a reaction.
  await ui.post({ tap: true }, { in: mk } as never)
  await clock.advance(50)
  expect(await reactOf()).toBe(null)
  await clock.advance(3_000)
  // Seven bursts deal every reaction exactly once before any repeats (a shuffle bag). The module's own
  // clock does not run here, so a column reaction is ended by posting done, as the module would.
  const seen: string[] = []
  for (let i = 0; i < 7; i += 1) {
    for (let j = 0; j < 4; j += 1) await ui.post({ tap: true }, { in: mk } as never)
    await clock.advance(50)
    const r = await reactOf()
    const all = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    seen.push(r ? r.kind : all.some(x => x.includes('◉')) ? 'snake' : 'none')
    if (r) await ui.post({ done: true }, { in: mk } as never)
    await clock.advance(12_000)
  }
  expect([...seen].sort()).toEqual(['chef', 'night', 'pacman', 'shake', 'snake', 'spider', 'storm'])
  await ui.unmount()
})

test('/snake runs the chase across the band and ends with a gulp', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.register', () => ({ value: { command: 'snake' } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const wide = { ...BAND, props: { ...BAND.props, bodyColumns: 170 } }
  const ui = await $.ui.mount(wide as never)
  const texts = async () => (await ui.findAll({ type: 'Text' })).map(x => x.text)
  expect((await texts()).some(x => x.includes('◉'))).toBe(false)
  await $.command.run({ command: 'snake', args: '' } as never)
  await clock.advance(200)
  expect((await texts()).some(x => x.includes('◉'))).toBe(true)
  let sawGulp = false
  for (let i = 0; i < 120 && !sawGulp; i += 1) {
    await clock.advance(80)
    sawGulp = (await texts()).some(x => x.includes('gulp.'))
  }
  expect(sawGulp).toBe(true)
  await clock.advance(4_000)
  expect((await texts()).some(x => x.includes('◉') || x.includes('gulp'))).toBe(false)
  await ui.unmount()
})

test('/ladder hands the mascot a climb it has not seen yet', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.register', () => ({ value: { command: 'ladder' } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const climbOf = async () => {
    const c = (await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))
    return (c?.props as { props?: { climb?: number; rows?: number } } | undefined)?.props
  }
  expect((await climbOf())?.climb).toBe(0)
  await $.command.run({ command: 'ladder', args: '' } as never)
  await clock.advance(100)
  const p = await climbOf()
  expect(p?.climb).toBe(1)
  // The column height rides along so the ladder knows how far up to go.
  expect((p?.rows ?? 0) >= 6).toBe(true)
  await ui.unmount()
})

test('Slim folds the band down to the mascot and the buttons; Bulk brings back every section and sends him up the ladder', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  let ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeDefined()
  // A section folded before going slim comes back open.
  await ui.press({ key: 'fold-plan' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /^Session\s*$/ })).toBeUndefined()
  const mascotProps = async () => ((await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))?.props as { props?: { climb?: number; rows?: number } } | undefined)?.props
  const climbBefore = (await mascotProps())?.climb ?? 0
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Max 20x/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▐▛███▜▌|▐▛███▜█/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Compact/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Bulk/ })).toBeDefined()
  expect((await mascotProps())?.climb ?? 0).toBe(climbBefore)
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Button', text: /^PLAN/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Session\s*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /^Context\s*$/ })).toBeDefined()
  const after = await mascotProps()
  expect(after?.climb).toBe(climbBefore + 1)
  expect((after?.rows ?? 0) >= 6).toBe(true)
  await ui.unmount()
})

test('the Dock tab steps the look and the choice reaches the rule and the menu accent', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  // From Config, ↑ to the tabs, ← three times lands on Dock.
  await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'left', in: menuKey })
  await ui.key({ key: 'left', in: menuKey })
  await ui.key({ key: 'left', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /TOP LINE/, in: menuKey } as never)).toBeDefined()
  // ↓ lands on the header switch, ↓ again on the line colour; → steps it from orange to yellow.
  await ui.key({ key: 'down', in: menuKey })
  await ui.key({ key: 'down', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^yellow$/, in: menuKey } as never)).toBeDefined()
  await ui.unmount()
  // The band's rule now draws yellow.
  const band = await $.ui.mount(BAND as never)
  const rule = await band.find({ type: 'Text', text: /^─+$/ })
  expect(rule?.props.color).toBe('warning')
  await band.unmount()
})

test('hiding the avatar drops its column and makes the slim band one row', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  await ui.key({ key: 'up', in: menuKey })
  for (let i = 0; i < 3; i += 1) await ui.key({ key: 'left', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  // Down to the AVATAR group's first row, "Show the avatar", and flip it off.
  for (let i = 0; i < 7; i += 1) await ui.key({ key: 'down', in: menuKey })
  expect(await ui.find({ type: 'Text', text: /^Show the avatar/, in: menuKey } as never)).toBeDefined()
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  await ui.unmount()
  let band = await $.ui.mount(BAND as never)
  expect((await band.findAll({ type: 'Client' } as never)).some(c => String(c.key).startsWith('mascot-'))).toBe(false)
  await band.press({ key: 'slim-toggle' })
  await clock.advance(50)
  expect(await band.find({ type: 'Text', text: /▐▛███▜▌|▐▛███▜█/ })).toBeUndefined()
  expect(await band.find({ type: 'Button', text: /Bulk/ })).toBeDefined()
  await band.press({ key: 'slim-toggle' })
  await clock.advance(50)
  await band.unmount()
})

test("/effort's own wording sets the lit level, in each phrasing the engine uses", async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const replies = ['Set effort level to low (saved as your default for new sessions): Quick', 'Ultracode off. Effort stays max.', 'Effort set to medium']
  let i = 0
  on('command.run', () => ({ text: replies[i++] ?? '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const lit = async () => (await ui.findAll({ type: 'Text' })).filter(x => x.props.bold === true && x.props.color === 'success').length
  await $.command.run({ command: 'effort', args: 'low' } as never)
  await clock.advance(50)
  expect(await lit()).toBeGreaterThan(0) // low's brackets are green and lit
  await $.command.run({ command: 'effort', args: '' } as never)
  await clock.advance(50)
  expect(await lit()).toBe(0) // max is lit now, not low
  await ui.unmount()
})

test("effort chips keep sending after the first: a spinner the dock's own command draws is not a turn", async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(`${e.command} ${e.args}`.trim())
    return { text: `Set effort level to ${e.args} (saved)` } as never
  })
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>spin</Text>
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-low' })
  await clock.advance(500)
  await clock.advance(100)
  // The engine draws its spinner while the command runs.
  const spin = await $.ui.mount({ ...BAND, component: 'Spinner', requestId: 'spinner', props: { word: 'Running', message: null, suffix: '…', mode: 'requesting' } } as never)
  await spin.unmount()
  await ui.press({ key: 'effort-medium' })
  await clock.advance(500)
  await clock.advance(100)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(500)
  await clock.advance(100)
  expect(runs).toEqual(['effort low', 'effort medium', 'effort xhigh'])
  expect(await ui.find({ type: 'Text', text: /after this turn/ })).toBeUndefined()
  await ui.unmount()
})

test('a chip level bridges requests only until /effort has run; the engine then owns the lit chip', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.run', (_$, e) => ({ text: `Set effort level to ${e.args} (saved)` } as never))
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-max' })
  await clock.advance(500)
  // /effort ran while idle, so the bridge is already gone: the engine's own level rides each request.
  const step = $.turn.step({ turnId: 't3', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 } as never)
  for await (const _c of step) { /* drain */ }
  expect(seen).toEqual(['high'])
  await $.turn.complete({ turnId: 't3', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1_000)
  // And the lit chip follows the engine: high, not max.
  const lit = (await ui.findAll({ type: 'Text' })).filter(x => x.props.bold === true && (x.props.color === 'error' || x.props.color === 'warning'))
  expect(lit.some(x => x.props.color === 'warning')).toBe(true)
  expect(lit.some(x => x.props.color === 'error')).toBe(false)
  await ui.unmount()
})

test('with no Bypass switch pending the dock leaves every permission prompt to the engine', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'deny', message: 'the engine decided' } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const answer = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_suggestions: [] } as never) as { decision?: { behavior: string; message?: string } }
  expect(answer.decision).toEqual({ behavior: 'deny', message: 'the engine decided' })
  await ui.unmount()
})
test('the footer line tells the dock the permission mode, and a switch to bypass makes the mascot say Careful!', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const hint = (text: string) => ({ ...BAND, component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking: false, hint: text } })
  let foot = await $.ui.mount(hint('⏸ manual mode on (shift+tab to cycle) · ? for shortcuts') as never)
  await foot.unmount()
  let ui = await $.ui.mount(BAND as never)
  const mk = await mascotIn(ui as never)
  const words = async () => (await ui.findAll({ type: 'Text', in: mk } as never)).map(x => x.text)
  expect((await words()).some(x => x.includes('Careful!'))).toBe(false)
  await ui.unmount()
  foot = await $.ui.mount(hint('⏵⏵ bypass permissions on (shift+tab to cycle) · ⇠ for agents') as never)
  await foot.unmount()
  ui = await $.ui.mount(BAND as never)
  expect((await ui.findAll({ type: 'Text', in: await mascotIn(ui as never) } as never)).some(x => x.text.includes('Careful!'))).toBe(true)
  await ui.unmount()
})

test('a /model switch shows on the dock as soon as the command finishes, before any request', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.run', (_$, e) => {
    if (e.command === 'model') sessionModel.id = 'claude-opus-5-5'
    return { text: 'Set model to Opus 5.5' } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const shows = async (id: string) => (await ui.findAll({ type: 'Text' })).some(x => x.text.includes(id))
  expect(await shows('claude-fable-5-1')).toBe(true)
  await $.command.run({ command: 'model', args: 'opus' } as never)
  await clock.advance(50)
  expect(await shows('claude-opus-5-5')).toBe(true)
  expect(await shows('claude-fable-5-1')).toBe(false)
  await ui.unmount()
})

test('an ultracode switch waiting for the turn runs once the prompt line says the session is idle', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(`${e.command} ${e.args}`.trim())
    return { text: 'Ultracode on (this session only): dynamic workflows on every task. Effort stays high.' } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  // A step with no turn.complete after it: the dock believes a turn is still running.
  for await (const _c of $.turn.step({ turnId: 't9', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  const ui = await $.ui.mount(BAND as never)
  const chip = (await ui.findAll({ type: 'Client' } as never)).find(c => String(c.key).startsWith('ultracode-chip-'))?.key as string
  await ui.post({ press: true }, { in: chip } as never)
  await clock.advance(100)
  expect(runs.some(r => r.startsWith('effort ultracode'))).toBe(false)
  const hint = await $.ui.mount({ ...BAND, component: 'PromptHint', requestId: 'hint2', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as never)
  await hint.unmount()
  await clock.advance(100)
  expect(runs).toContain('effort ultracode on')
  await ui.unmount()
})

test('the finished sound plays once the whole answer is in, and the needs-you sound skips the idle reminder', async ($, on) => {
  const clock = bottom(on)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('classic.Stop', () => ({}) as never)
  on('classic.Notification', () => ({}) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()

  // Still waiting on background agents: not finished yet.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1' }] } as never)
  await clock.advance(50)
  expect(played).toEqual([])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await clock.advance(50)
  expect(played).toEqual(['sounds/success.mp3'])

  await clock.advance(5_000)
  await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' } as never)
  await clock.advance(50)
  expect(played.length).toBe(1)

  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  await clock.advance(50)
  expect(played).toEqual(['sounds/success.mp3', 'sounds/ping.mp3'])
})

test('cycling a sound in the Dock tab previews the new choice and keeps it', async ($, on) => {
  const clock = bottom(on)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 90 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  expect(await ui.find({ type: 'Text', text: /^ *SOUND *$/, in: menuKey } as never)).toBeDefined()
  await ui.post({ select: 'dock-snd-done', dir: 'next' }, { in: menuKey } as never)
  await clock.settle()
  expect(played).toEqual(['sounds/ping.mp3'])
  expect(await ui.find({ type: 'Text', text: /^Ping$/, in: menuKey } as never)).toBeDefined()
  await ui.unmount()
})

test('each fifteen-minute window of quiet is one coin toss: a heads speaks, a tails stays quiet', async ($, on) => {
  const clock = bottom(on, 200, 1_011_000)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const voices = () => played.filter(p => p === 'sounds/idle-voice.mp3').length
  // Each window: fifteen quiet minutes, then a look at him, so a speech that rolled ends as it would on screen.
  const window = async () => {
    await quietFor(clock, 15 * 60_000)
    const band = await $.ui.mount(BAND as never)
    const mascot = await mascotIn(band as never)
    if (mascot) {
      await band.post({ done: true }, { in: mascot } as never)
      await band.post({ talked: true }, { in: mascot } as never)
    }
    await band.unmount()
  }
  // The dock loads at 1011000 ms, so the first window opens at 1911000 (heads) and the second at 2811000 (tails).
  await window()
  expect(voices()).toBe(1)
  await window()
  expect(voices()).toBe(1)
})

test('a dock that sees another dock speak moves his mouth in step and plays no clip', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { chatter: { spokeAt: 999_000 } })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.advance(1_000)
  const ui = await $.ui.mount(BAND as never)
  const mk = await mascotIn(ui as never)
  const talk = ((await ui.findAll({ type: 'Client' } as never)).find(x => x.key === mk)?.props as { props?: { talk?: { startedAt?: number } | null } } | undefined)?.props?.talk
  expect(talk?.startedAt).toBe(999_000)
  expect(played.filter(p => p === 'sounds/idle-voice.mp3')).toEqual([])
  await ui.unmount()
})

test('a window another dock already rolled is not rolled again here', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { chatter: { roll: { window: 1_000_000 + 15 * 60_000, by: 'another dock' } } })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await quietFor(clock, 15 * 60_000)
  expect(played.filter(p => p === 'sounds/idle-voice.mp3')).toEqual([])
})

test('a turn starts the quiet count over: no roll until fifteen quiet minutes after it', async ($, on) => {
  const clock = bottom(on)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await quietFor(clock, 8 * 60_000)
  for await (const _c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  // Twenty minutes since the dock loaded, but only twelve since the turn: no window has closed yet.
  await quietFor(clock, 12 * 60_000)
  expect(played.filter(p => p === 'sounds/idle-voice.mp3')).toEqual([])
})

test('/chatter makes him say it now', async ($, on) => {
  const clock = bottom(on)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? '')
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('command.run', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await $.command.run({ command: 'chatter', args: '' } as never)
  await clock.advance(50)
  expect(played).toEqual(['sounds/idle-voice.mp3'])
})

test('Notifications off in the SOUND section silences every chime, and Robot voice off keeps him quiet', async ($, on) => {
  const clock = bottom(on)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? '')
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  on('classic.Stop', () => ({}) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  expect(await ui.find({ type: 'Text', text: /^Robot voice/, in: menuKey } as never)).toBeDefined()
  await ui.post({ select: 'dock-snd-notify', dir: 'next' }, { in: menuKey } as never)
  await ui.post({ select: 'dock-idle-voice', dir: 'next' }, { in: menuKey } as never)
  await clock.settle()
  await ui.unmount()

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await clock.advance(11 * 60_000)
  expect(played).toEqual([])
})

test('with Background servers and watchers on, a dev server runs in the background and a test run does not', async ($, on) => {
  const clock = bottom(on)
  const calls: { command: string; bg: boolean }[] = []
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    calls.push({ command: e.command, bg: e.run_in_background === true })
    return { result: { stdout: '' } } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const run = (command: string) => $.tool.call({ tool: 'Bash', tool_use_id: `t-${calls.length}`, command } as never)

  // Off by default: Claude's own choice stands.
  await run('npm run dev')
  expect(calls.at(-1)).toEqual({ command: 'npm run dev', bg: false })

  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  await ui.post({ select: 'dock-auto-bg', dir: 'next' }, { in: menuKey } as never)
  await clock.settle()
  await ui.unmount()

  await run('npm run dev')
  await run('tail -f logs/server.log')
  await run('npm test')
  await run('docker compose up -d')
  expect(calls.slice(1)).toEqual([
    { command: 'npm run dev', bg: true },
    { command: 'tail -f logs/server.log', bg: true },
    { command: 'npm test', bg: false },
    { command: 'docker compose up -d', bg: false },
  ])
})

test('shells started before the dock loaded still count: the footer gives the number, a Stop gives the details', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('classic.Stop', () => ({}) as never)
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const runningText = async () => {
    const ui = await $.ui.mount(BAND as never)
    const texts = (await ui.findAll({ type: 'Text' })).map(x => x.text)
    await ui.unmount()
    const at = texts.findIndex(x => /running/.test(x))
    return texts.slice(Math.max(0, at - 1), at + 1).join('')
  }
  expect(await runningText()).toMatch(/^0 running/)

  // The footer already knows about a shell the dock never saw start.
  const foot = await $.ui.mount({ ...BAND, component: 'PromptHint', requestId: 'hint-sh', props: { isDraft: false, isWorking: false, hint: '⏵⏵ bypass permissions on · ← for agents · 1 shell · ↓ to manage' } } as never)
  await foot.unmount()
  expect(await runningText()).toMatch(/^1 running/)

  // A Stop lists it, so the shells view can show it by name.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'bsus8folf', type: 'shell', status: 'running', description: 'Render the launch film', command: 'node render.mjs' }] } as never)
  await clock.settle()
  const band = await $.ui.mount(BAND as never)
  await band.press({ key: 'shells-open' })
  await clock.settle()
  expect(await band.find({ type: 'Text', text: /Render the launch film/ })).toBeDefined()
  await band.unmount()
})

test('the dock draws in the terminal and nothing on any other surface', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const dockRows = async (surface: string) => {
    const ui = await $.ui.mount({ ...BAND, surface } as never)
    const texts = (await ui.findAll({ type: 'Text' } as never)).map(x => x.text)
    await ui.unmount()
    return texts.filter(t => /^(Session|Week)\b/.test(t))
  }
  expect((await dockRows('terminal')).length).toBeGreaterThan(0)
  expect(await dockRows('desktop')).toEqual([])
})

test('Bulk after Slim hands the mascot a fresh climb request, so it climbs even though it was remounted', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const mascotProps = async () => ((await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))?.props as { props?: { climb?: number; climbAt?: number } } | undefined)?.props
  const before = (await mascotProps())?.climb ?? 0
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(50)
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(50)
  const after = await mascotProps()
  expect(after?.climb).toBe(before + 1)
  expect((after?.climbAt ?? 0) > 0).toBe(true)
  await ui.unmount()
})

test('the Bypass button stays off until Settings turns it on', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const band = await $.ui.mount(BAND as never)
  expect(await band.find({ type: 'Button', text: /^Bypass/ })).toBeUndefined()
  await band.unmount()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  await ui.post({ select: 'dock-show-bypass', dir: 'next' }, { in: menuKey } as never)
  await clock.settle()
  await ui.unmount()
  const after = await $.ui.mount(BAND as never)
  expect(await after.find({ type: 'Button', text: /Bypass/ })).toBeDefined()
  await after.unmount()
})

test('/clear starts the context figures afresh, not from the old conversation', async ($, on) => {
  const clock = bottom(on)
  let percent = 25
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: percent * 2000, percent }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /25%/ })).toBeDefined()
  percent = 40
  await $.classic.SessionStart({ source: 'clear', session_id: 'new' } as never)
  await clock.settle()
  await ui.unmount()
  const after = await $.ui.mount(BAND as never)
  expect(await after.find({ type: 'Text', text: /40%/ })).toBeDefined()
  expect(await after.find({ type: 'Text', text: /25%/ })).toBeUndefined()
  await after.unmount()
})

test('saved settings are restored when the dock starts', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { showBypass: true, look: { uiColor: 2 } })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const band = await $.ui.mount(BAND as never)
  expect(await band.find({ type: 'Button', text: /Bypass/ })).toBeDefined()
  await band.unmount()
})

test('the Settings cursor stops at the last row and climbs back to the tab bar without getting lost', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('tool.list', () => ({ value: [] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  for (let i = 0; i < 60; i += 1) await ui.key({ key: 'down', in: menuKey })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^Robot voice/, in: menuKey } as never))?.props.bold).toBe(true)
  // Up past the first row reaches the tab bar, and the menu still answers there: → then Enter opens Config.
  for (let i = 0; i < 80; i += 1) await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Reasoning effort/, in: menuKey } as never)).toBeDefined()
  await ui.unmount()
})

test('a chip pressed during a turn reaches the next request even when the engine names no effort', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  // A model request has started, so a turn is running and /effort must wait for it.
  for await (const _c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 } as never)) {
    // drain
  }
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(100)
  // The next request names no effort; the chip's level still rides it.
  for await (const _c of $.turn.step({ turnId: 't1', index: 1, model: 'claude-opus-5-5', messageCount: 2 } as never)) {
    // drain
  }
  expect(seen.at(-1)).toBe('xhigh')
  await ui.unmount()
})

test('two effort levels picked in quick succession: only the last one is sent', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return { text: `Set effort level to ${e.args} (saved)` } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(50)
  await ui.press({ key: 'effort-low' })
  await clock.advance(500)
  // The xhigh pick was replaced before it went out, so only low is sent.
  expect(runs).toEqual(['low'])
  await ui.unmount()
})

test('a pick while a run is in flight waits for it and goes next; the older run never undoes it', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  const finish: (() => void)[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return new Promise(resolve => finish.push(() => resolve({ text: `Set effort level to ${e.args} (saved)` } as never)))
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(500)
  expect(runs).toEqual(['xhigh'])
  await ui.press({ key: 'effort-low' })
  await clock.advance(500)
  // The xhigh run is still in flight, so low waits for it: only one /effort at a time.
  expect(runs).toEqual(['xhigh'])
  finish[0]?.()
  await clock.advance(50)
  expect(runs).toEqual(['xhigh', 'low'])
  finish[1]?.()
  await clock.advance(50)
  await ui.unmount()
})

test('picking the level the engine already holds, before it is sent, cancels the switch: nothing is sent', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return { text: `Set effort level to ${e.args} (saved)` } as never
  })
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  // The engine reports its level on a request: high.
  for await (const _c of $.turn.step({ turnId: 't5', index: 0, model: 'claude-fable-5-1', effort: 'high', messageCount: 1 } as never)) {
    // drain
  }
  await $.turn.complete({ turnId: 't5', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(100)
  await ui.press({ key: 'effort-high' })
  await clock.advance(500)
  expect(runs).toEqual([])
  await ui.unmount()
})
test('UltraCode shows the star until the engine has it, then lights; a turn that is still running holds it', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return { text: `Ultracode ${String(e.args).replace('ultracode ', '')} (this session only).` } as never
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('turn.step', async function* (_$, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  for await (const _c of $.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', messageCount: 1 } as never)) {
    // drain
  }
  const ui = await $.ui.mount(BAND as never)
  const ultraLabel = async () => ((await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('ultracode-chip'))?.props as { props?: { label?: string; lit?: boolean } } | undefined)?.props
  const chipKey = (await ui.findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('ultracode-chip'))!.key as string
  await ui.post({ press: true }, { in: chipKey } as never)
  await clock.advance(200)
  expect(runs).toEqual([])
  expect(STAR_GLYPHS).toContain(bare((await ultraLabel())?.label))
  expect((await ultraLabel())?.lit).toBe(false)
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
  await clock.advance(1_000)
  expect(runs).toEqual(['ultracode on'])
  expect((await ultraLabel())?.label).toBe('ultracode')
  expect((await ultraLabel())?.lit).toBe(true)
  await ui.unmount()
})

test('a change in Settings shows in its row at once, without reopening the pane', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const pane = { ...BAND, component: 'Pane', requestId: 'cc-dock-config', props: { title: 'Settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } }
  const ui = await $.ui.mount(pane as never)
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  const rowValue = async () => (await ui.find({ type: 'Text', text: /^Background servers and watchers/, in: menuKey } as never))
  const before = await rowValue()
  await ui.post({ select: 'dock-auto-bg', dir: 'next' }, { in: menuKey } as never)
  await clock.advance(50)
  // The same row, read again without remounting the pane, now carries the new value.
  const valueText = (await ui.findAll({ type: 'Text', in: menuKey } as never)).map(x => x.text)
  const idx = valueText.findIndex(t => /^Background servers and watchers/.test(t))
  expect(before).toBeDefined()
  expect(idx).toBeGreaterThanOrEqual(0)
  expect(valueText.slice(idx, idx + 4).some(t => t.trim() === 'on')).toBe(true)
  await ui.unmount()
})

test('Compact: the first press asks Yes?, the second compacts once and the avatar says success!', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  let calls = 0
  on('session.compact', () => {
    calls += 1
    return { messages: [{ role: 'user', text: 'summary', toolUses: [] }], tokensBefore: 891000, tokensAfter: 120000 } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'compact-run' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Button', text: /Yes\?/ })).toBeDefined()
  expect(calls).toBe(0)
  await ui.press({ key: 'compact-run' })
  await clock.advance(50)
  expect(calls).toBe(1)
  expect(await ui.find({ type: 'Text', text: /success!/, in: await mascotIn(ui as never) } as never)).toBeDefined()
  await ui.unmount()
})


// A session.usage answer at a context percentage; `startedAt` defaults to the mocked clock's start.
const usageAt = (percent: number, startedAt = 1_000_000) => () =>
  ({ value: { startedAt, context: { window: 200000, tokens: percent * 2000, percent }, rateLimits: [], cost: { usd: 0 } } }) as never
const answerStep = (e: { turnId: string; index: number }) => ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }) as never
const stepOf = (turnId: string, index: number, extra: Record<string, unknown> = {}) =>
  ({ turnId, index, model: 'claude-opus-5-5', effort: 'high', messageCount: index + 1, ...extra }) as never
const drain = async (stream: AsyncIterable<unknown>): Promise<void> => {
  for await (const _c of stream) {
    // drain
  }
}
const completeTurn = ($: { turn: { complete: (e: never) => Promise<unknown> } }, turnId = 't1') =>
  $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' } as never)
const hintOf = (isWorking: boolean, hint = '? for shortcuts') => ({ ...BAND, component: 'PromptHint', requestId: 'hint', props: { isDraft: false, isWorking, hint } }) as never
const paneOf = (id: string, bodyColumns = 100) =>
  ({ ...BAND, component: 'Pane', requestId: id, props: { title: id, isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } }) as never
type Found = { key?: string; props: unknown; text: string }
const ultraChip = async (ui: unknown) => {
  const c = (await (ui as { findAll: (q: never) => Promise<Found[]> }).findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('ultracode-chip'))
  return { key: c?.key as string, ...((c?.props as { props?: { label?: string; lit?: boolean } } | undefined)?.props ?? {}) }
}
const mascotProps = async (ui: unknown) => {
  const c = (await (ui as { findAll: (q: never) => Promise<Found[]> }).findAll({ type: 'Client' } as never)).find(x => String(x.key).startsWith('mascot-'))
  return (c?.props as { props?: { bubble?: string[]; react?: { kind: string; id: number } | null; talk?: unknown } } | undefined)?.props
}
// The element that directly holds the one keyed `key` in a drawn tree.
type Node = { props?: Record<string, unknown>; children?: unknown[] }
const holderOf = (node: Node, key: string): Node | undefined => {
  for (const c of node.children ?? []) {
    if (typeof c !== 'object' || c === null) continue
    if ((c as Node).props?.key === key) return node
    const deeper = holderOf(c as Node, key)
    if (deeper) return deeper
  }
  return undefined
}

test('a turn the footer still calls working is not ended by ten quiet minutes, so a waiting switch keeps waiting', { timeoutMs: 120_000 }, async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(`${e.command} ${e.args}`.trim())
    return { text: 'Ultracode on (this session only). Effort stays high.' } as never
  })
  on('turn.step', async function* (_$, e) {
    return answerStep(e)
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await drain($.turn.step(stepOf('t1', 0)))
  const ui = await $.ui.mount(BAND as never)
  const footer = await $.ui.mount(hintOf(true))
  await ui.post({ press: true }, { in: (await ultraChip(ui)).key } as never)
  // The model makes no request for eleven minutes (a long workflow) while the footer keeps saying the turn works.
  for (let i = 0; i < 13; i += 1) {
    await clock.advance(50_000)
    await footer.find({ type: 'Text' })
  }
  expect(runs).toEqual([])
  await footer.unmount()
  const idle = await $.ui.mount(hintOf(false))
  await clock.advance(100)
  expect(runs).toEqual(['effort ultracode on'])
  await idle.unmount()
  await ui.unmount()
})

test('a /effort the person types while an UltraCode switch waits leaves no spinner behind', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  on('command.run', (_$, e) => ({ text: `Set effort level to ${e.args} (saved)` }) as never)
  on('turn.step', async function* (_$, e) {
    return answerStep(e)
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await drain($.turn.step(stepOf('t1', 0)))
  const ui = await $.ui.mount(BAND as never)
  await ui.post({ press: true }, { in: (await ultraChip(ui)).key } as never)
  await clock.advance(200)
  expect(STAR_GLYPHS).toContain(bare((await ultraChip(ui)).label))
  // The person settles it themselves with a typed /effort, then the turn ends.
  await $.command.run({ command: 'effort', args: 'high' } as never)
  await completeTurn($)
  await clock.advance(30_000)
  expect((await ultraChip(ui)).label).toBe('ultracode')
  expect((await ultraChip(ui)).lit).toBe(false)
  await ui.unmount()
})

test('a typed /effort that names no level ends the level a chip was forcing on each request', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  on('command.run', () => ({ text: '' }) as never)
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e.effort)
    return answerStep(e)
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await drain($.turn.step(stepOf('t1', 0)))
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-max' })
  await clock.advance(100)
  await $.command.run({ command: 'effort', args: '' } as never)
  await drain($.turn.step(stepOf('t1', 1, { effort: 'low' })))
  expect(seen.at(-1)).toBe('low')
  await ui.unmount()
})

test('after Compact in the Context view the grid is counted again, not left on counting…', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', (_$, e) => ({
    value: {
      startedAt: 0,
      context: {
        window: 200000, tokens: 50000, percent: 25,
        breakdown: e.breakdown ? {
          categories: [
            { name: 'System prompt', tokens: 12000, color: 'permission', isDeferred: false, kind: 'used' },
            { name: 'Free space', tokens: 150000, color: 'inactive', isDeferred: false, kind: 'free' },
          ],
          totalTokens: 50000, maxTokens: 200000, rawMaxTokens: 200000, autocompactSource: 'model', percentage: 25,
          gridRows: [[{ color: 'permission', isFilled: true }, { color: 'inactive', isFilled: false }]],
          model: 'Fable 5.1', memoryFiles: [], mcpTools: [], agents: [], isAutoCompactEnabled: true, apiUsage: null,
        } : undefined,
      },
      rateLimits: [], cost: { usd: 0 },
    },
  }) as never)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'context-open' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^System prompt:/ })).toBeDefined()
  await ui.press({ key: 'compact-run' })
  await clock.advance(50)
  await ui.press({ key: 'compact-run' })
  await clock.advance(5_000)
  expect(await ui.find({ type: 'Text', text: /^counting…$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^System prompt:/ })).toBeDefined()
  await ui.unmount()
})

test('picking the level a resumed session held before still sends when the setting changed in between', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  on('classic.SessionStart', () => ({}) as never)
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return { text: `Set effort level to ${e.args} (saved)` } as never
  })
  on('turn.step', async function* (_$, e) {
    return answerStep(e)
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await drain($.turn.step(stepOf('t5', 0)))
  await completeTurn($, 't5')
  engineConfig.effort = 'low'
  await $.classic.SessionStart({ source: 'resume', session_id: 'other' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-high' })
  await clock.advance(600)
  expect(runs).toEqual(['high'])
  await ui.unmount()
})

test('picking the level a typed /effort moved away from still sends it', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  const runs: string[] = []
  on('command.run', (_$, e) => {
    runs.push(String(e.args))
    return { text: `Set effort level to ${e.args} (saved)` } as never
  })
  on('turn.step', async function* (_$, e) {
    return answerStep(e)
  })
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  await drain($.turn.step(stepOf('t5', 0)))
  await completeTurn($, 't5')
  await $.command.run({ command: 'effort', args: 'low' } as never)
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-high' })
  await clock.advance(600)
  expect(runs).toEqual(['low', 'high'])
  await ui.unmount()
})

test('/clear starts the Usage tab wall clock over', async ($, on) => {
  const clock = bottom(on)
  let startedAt = 100_000
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => usageAt(25, startedAt)())
  on('classic.SessionStart', () => ({}) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  startedAt = clock.now()
  await $.classic.SessionStart({ source: 'clear', session_id: 'new' } as never)
  await clock.settle()
  const ui = await $.ui.mount(paneOf('cc-dock-config'))
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  // From Dock, ↑ reaches the tabs; three → presses land on Usage.
  await ui.key({ key: 'up', in: menuKey })
  for (let i = 0; i < 3; i += 1) await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  const texts = (await ui.findAll({ type: 'Text', in: menuKey } as never)).map(x => x.text)
  const at = texts.findIndex(t => /Total duration \(wall\)/.test(t))
  expect(at).toBeGreaterThanOrEqual(0)
  expect(texts[at + 1]).toBe('0m')
  await ui.unmount()
})

test('an older /effort reply does not undo the newest pick on the requests that follow', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  const finish: (() => void)[] = []
  on('command.run', (_$, e) => new Promise(resolve => finish.push(() => resolve({ text: `Set effort level to ${e.args} (saved)` } as never))))
  const seen: unknown[] = []
  on('turn.step', async function* (_$, e) {
    seen.push(e.effort)
    return answerStep(e)
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-xhigh' })
  await clock.advance(500)
  await ui.press({ key: 'effort-low' })
  await clock.advance(50)
  // A turn starts while the xhigh run is still in flight; low rides it.
  await drain($.turn.step(stepOf('t1', 0)))
  expect(seen.at(-1)).toBe('low')
  finish[0]?.()
  await clock.advance(50)
  await drain($.turn.step(stepOf('t1', 1, { effort: 'xhigh' })))
  expect(seen.at(-1)).toBe('low')
  await ui.unmount()
})

test('one command name that is taken does not cost the dock its other commands', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  const names: string[] = []
  on('command.register', (_$, e) => {
    names.push(String(e.name))
    if (e.name === 'snake') return { deny: 'taken' } as never
    return { value: { command: String(e.name) } } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  expect(names).toEqual(['snake', 'ladder', 'chatter'])
})

test('a reaction rolled while the mascot was not drawn is dropped, so the next burst of taps still starts one', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const mk = await mascotIn(ui as never)
  const roll = async () => {
    for (let i = 0; i < 8; i += 1) {
      for (let j = 0; j < 4; j += 1) await ui.post({ tap: true }, { in: mk } as never)
      await clock.advance(50)
      const react = (await mascotProps(ui))?.react
      if (react) return react
      // That burst rolled the snake chase on the band; let it end.
      await clock.advance(12_000)
    }
    return undefined
  }
  const first = await roll()
  expect(first).toBeDefined()
  // He is not drawn while the shells page is open, so nothing ever tells the hooks the reaction is over.
  await ui.press({ key: 'shells-open' })
  await clock.advance(20_000)
  await ui.press({ key: 'shells-close' })
  expect((await mascotProps(ui))?.react).toBe(null)
  const second = await roll()
  expect(second).toBeDefined()
  expect(second?.id).not.toBe(first?.id)
  await ui.unmount()
})

test('a clip nobody saw played does not stay set once it has run its length', async ($, on) => {
  const clock = bottom(on)
  on('audio.play', () => ({ value: undefined }) as never)
  on('command.run', () => ({ text: '' }) as never)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'shells-open' })
  await $.command.run({ command: 'chatter', args: '' } as never)
  await clock.advance(60_000)
  await ui.press({ key: 'shells-close' })
  expect((await mascotProps(ui))?.talk).toBe(null)
  await ui.unmount()
})

test('in Slim the robot voice stays quiet, since he is not drawn to move his mouth', async ($, on) => {
  const clock = bottom(on, 200, 1_011_000)
  const played: string[] = []
  on('audio.play', (_$, e) => {
    played.push(/sounds\/[a-z-]+\.mp3/.exec(JSON.stringify(e))?.[0] ?? JSON.stringify(e))
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'slim-toggle' })
  // The first quiet window is the one that speaks when he is drawn (the coin toss test above).
  await quietFor(clock, 15 * 60_000)
  expect(played.filter(p => p === 'sounds/idle-voice.mp3')).toEqual([])
  await ui.unmount()
})

test('while Compact runs the bubble says compacting with dots that move, and a refusal gives its reason', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  let finish: () => void = () => {}
  on('session.compact', () => new Promise(resolve => {
    finish = () => resolve({ messages: [{ role: 'user', text: 'summary', toolUses: [] }] } as never)
  }))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const mk = await mascotIn(ui as never)
  const lines = async () => (await ui.findAll({ type: 'Text', in: mk } as never)).map(x => x.text.trim())
  await ui.press({ key: 'compact-run' })
  const running = ui.press({ key: 'compact-run' })
  await clock.advance(50)
  expect((await lines()).includes('compacting')).toBe(true)
  const dots = new Set<string>()
  for (let i = 0; i < 12; i += 1) {
    await clock.advance(120)
    const shown = (await lines()).find(t => /^\.{1,3}$/.test(t))
    if (shown) dots.add(shown)
  }
  expect([...dots].sort()).toEqual(['.', '..', '...'])
  finish()
  await running
  expect((await lines()).some(t => /success!/.test(t))).toBe(true)
  await ui.unmount()
})

test('a compaction the engine refuses says why beside the buttons, then lets go of the reason', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  on('session.compact', () => ({ skip: 'nothing to compact' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'compact-run' })
  await ui.press({ key: 'compact-run' })
  await clock.advance(50)
  expect(await ui.find({ type: 'Text', text: /nothing to compact/ })).toBeDefined()
  await clock.advance(9_000)
  expect(await ui.find({ type: 'Text', text: /nothing to compact/ })).toBeUndefined()
  await ui.unmount()
})

// A dock showing its Bypass button, the permission check answering `decision`, and every Bash call counted.
const BYPASS_PROBE = 'touch /tmp/cc-dock-bypass-probe'
const bypassDock = async ($: { session: { start: (e: never) => Promise<unknown> } }, on: On, decision: 'allow' | 'ask' | 'deny', options: { probe?: unknown; hold?: boolean } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, { showBypass: true })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  const checks: unknown[] = []
  on('tool.check', (_$, e) => {
    checks.push(e)
    return { decision } as never
  })
  const calls: string[] = []
  const gate = { release: () => {} }
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    calls.push(e.command)
    if (options.hold) return new Promise(resolve => { gate.release = () => resolve({ result: { stdout: '' } } as never) }) as never
    return (options.probe ?? { result: { stdout: '' } }) as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  return { clock, checks, calls, gate }
}
test('Bypass tells you it is already enabled when the permission check allows the probe, then clears the note', async ($, on) => {
  const { clock, calls } = await bypassDock($, on, 'allow')
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  await ui.press({ key: 'bypass-run' })
  expect(await ui.find({ type: 'Text', text: /already enabled/ })).toBeDefined()
  await clock.advance(2_000)
  expect(await ui.find({ type: 'Text', text: /already enabled/ })).toBeDefined()
  await clock.advance(1_000)
  expect(await ui.find({ type: 'Text', text: /already enabled/ })).toBeUndefined()
  expect(calls).toEqual([])
  await ui.unmount()
})

test('Bypass runs its probe once when the permission check would ask', async ($, on) => {
  const { calls } = await bypassDock($, on, 'ask')
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  await ui.press({ key: 'bypass-run' })
  expect(calls).toEqual([BYPASS_PROBE])
  await ui.unmount()
})

test('Bypass runs nothing when the footer already shows bypass', async ($, on) => {
  const { checks, calls } = await bypassDock($, on, 'ask')
  const footer = await $.ui.mount(hintOf(false, '⏵⏵ bypass permissions on (shift+tab to cycle) · ⇠ for agents'))
  await footer.unmount()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  await ui.press({ key: 'bypass-run' })
  expect(await ui.find({ type: 'Text', text: /already enabled/ })).toBeDefined()
  expect(calls).toEqual([])
  expect(checks).toEqual([])
  await ui.unmount()
})

test('Bypass says it is blocked, and runs nothing, when the permission check refuses the probe', async ($, on) => {
  const { calls } = await bypassDock($, on, 'deny')
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  await ui.press({ key: 'bypass-run' })
  expect(await ui.find({ type: 'Text', text: /bypass: blocked/ })).toBeDefined()
  expect(calls).toEqual([])
  await ui.unmount()
})

test('a probe the engine refuses is reported, never passed off as already enabled', async ($, on) => {
  await bypassDock($, on, 'ask', { probe: { deny: 'plan mode allows no commands' } })
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  await ui.press({ key: 'bypass-run' })
  expect(await ui.find({ type: 'Text', text: /bypass: plan mode allows no commands/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /already enabled/ })).toBeUndefined()
  await ui.unmount()
})

test('while the Bypass probe waits, the dock answers only the probe’s own permission prompt', async ($, on) => {
  on('classic.PermissionRequest', () => ({ decision: { behavior: 'deny', message: 'the engine decided' } }) as never)
  const { clock, gate } = await bypassDock($, on, 'ask', { hold: true })
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'bypass-run' })
  const confirming = ui.press({ key: 'bypass-run' })
  await clock.settle()
  const ask = (command: string) => $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command }, permission_suggestions: [] } as never) as Promise<{ decision?: { behavior: string; updatedPermissions?: { type: string; mode: string }[] } }>
  const other = await ask('rm -rf build')
  expect(other.decision?.behavior).toBe('deny')
  const probe = await ask(BYPASS_PROBE)
  expect(probe.decision?.behavior).toBe('allow')
  expect(probe.decision?.updatedPermissions).toEqual([{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }])
  gate.release()
  await confirming
  await ui.unmount()
})

test('the Bypass probe command is never listed among the shells, whoever runs it', async ($, on) => {
  await bypassDock($, on, 'ask')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_probe', command: BYPASS_PROBE, description: 'Dock permission probe' } as never)
  const ui = await $.ui.mount(BAND as never)
  expect(await ui.find({ type: 'Text', text: /^just finished$/ })).toBeUndefined()
  await ui.unmount()
})

test('in Slim the button strip wraps in a narrow pane, so Bulk is never clipped', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 50 } } as never)
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(50)
  const strip = holderOf((await ui.drawn()) as Node, 'slim-toggle-wrap')
  expect(strip?.props?.flexWrap).toBe('wrap')
  expect(strip?.props?.height).toBeUndefined()
  await ui.unmount()
})

test('in a narrow pane the chip row and the button row wrap rather than squeeze their labels', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 40 } } as never)
  const tree = (await ui.drawn()) as Node
  expect(holderOf(tree, 'effort-low-wrap')?.props?.flexWrap).toBe('wrap')
  expect(holderOf(tree, 'config-open-wrap')?.props?.flexWrap).toBe('wrap')
  await ui.unmount()
})

test('at 90 percent the avatar asks Compact? once, and asks again only after the context fell below and crossed again', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(92))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const asks = async () => ((await mascotProps(ui))?.bubble ?? []).join('').includes('Compact?')
  // A finished turn each time keeps the idle reactions, which the 90 second check also rolls, out of the way.
  const nextCheck = async () => {
    await clock.advance(61_000)
    await completeTurn($)
    await clock.advance(30_000)
  }
  await nextCheck()
  expect(await asks()).toBe(true)
  await nextCheck()
  expect(await asks()).toBe(false)
  const measure = (percent: number) => $.session.measure({ context: { window: 200000, tokens: percent * 2000, percent }, rateLimits: [], changed: ['context'] } as never)
  await measure(50)
  await nextCheck()
  await measure(95)
  await nextCheck()
  expect(await asks()).toBe(true)
  await ui.unmount()
})

test('a Compact? question that came while he was folded away in Slim is asked again once he is drawn', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(92))
  on('turn.complete', () => ({ text: '' }) as never)
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(91_000)
  await ui.press({ key: 'slim-toggle' })
  await clock.advance(20_000)
  await completeTurn($)
  await clock.advance(70_000)
  expect(((await mascotProps(ui))?.bubble ?? []).join('').includes('Compact?')).toBe(true)
  await ui.unmount()
})

test('an effort chip shows the star while its switch is on the way and lights only once the engine has it', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  let finish: () => void = () => {}
  on('command.run', () => new Promise(resolve => {
    finish = () => resolve({ text: 'Set effort level to low (saved)' } as never)
  }))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(BAND as never)
  const chip = async () => {
    const b = await ui.find({ type: 'Button', key: 'effort-low' })
    return { label: bare(b?.props.label as string), lit: b?.props.dimColor !== true }
  }
  await ui.press({ key: 'effort-low' })
  // Sent, not yet answered.
  await clock.advance(500)
  expect(STAR_GLYPHS).toContain((await chip()).label)
  expect((await chip()).lit).toBe(false)
  finish()
  await clock.advance(1_000)
  expect(await chip()).toEqual({ label: 'low', lit: true })
  await ui.unmount()
})

test('in a narrow pane a click on a Settings row lands on the row clicked, however the hint wraps', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', usageAt(25))
  await $.session.start({ cwd: '/tmp' } as never)
  await clock.settle()
  const ui = await $.ui.mount(paneOf('cc-dock-config'))
  const menuKey = (await ui.find({ type: 'Client' } as never))!.key as string
  // From Dock, ↑ reaches the tabs; → once and Enter open Config.
  await ui.key({ key: 'up', in: menuKey })
  await ui.key({ key: 'right', in: menuKey })
  await ui.key({ key: 'return', in: menuKey })
  await clock.settle()
  await ui.resize({ columns: 100, rows: 30, in: menuKey })
  // Above the rows: the tab bar, a blank line, the hint over two lines, a blank line. The second row is line 6.
  await ui.pointer({ type: 'down', x: 4, y: 6, button: 'left', in: menuKey })
  expect((await ui.find({ type: 'Text', text: /^Fast mode/, in: menuKey } as never))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^Reasoning effort/, in: menuKey } as never))?.props.bold).not.toBe(true)
  await ui.unmount()
})

test('picking max fills /effort max into the prompt and runs nothing until Enter', async ($, on) => {
  const clock = bottom(on)
  on('session.start', () => ({ cwd: '/tmp' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 50000, percent: 25 }, rateLimits: [], cost: { usd: 0 } } }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  const effortRuns: string[] = []
  on('command.run', (_$, e) => {
    effortRuns.push(`${e.command} ${e.args}`.trim())
    return { text: '' } as never
  })
  const filled: string[] = []
  on('prompt.fill', (_$, e) => {
    filled.push((e as { text: string }).text)
    return { isFilled: true } as never
  })
  await $.session.start({ cwd: '/tmp' } as never)
  const ui = await $.ui.mount(BAND as never)
  await ui.press({ key: 'effort-max' })
  await clock.advance(2000)
  expect(filled).toEqual(['/effort max'])
  expect(effortRuns).toEqual([])
  await ui.unmount()
})
