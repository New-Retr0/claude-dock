import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

const SEP = ' ⠀·⠀ '

type Ctx = Parameters<TestBody>[0]
type Notice = { tool_use_id: string; text: string | undefined }
type Listed = { id: string; description: string; type: string; status: string }

// The test is the bottom of the chain: it draws a ToolUse row from its (possibly rewritten) description.
const drawToolUseBeneath = (on: On): Notice[] => {
  const notices: Notice[] = []
  on('ui.notice', (_$, e) => { notices.push(e as Notice); return { value: undefined } as never })
  on('ui.render', { component: 'ToolUse' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    const description = (e.props.input as { description?: string }).description ?? ''
    return <Text>{`${e.props.tool}(${description})`}</Text>
  })
  return notices
}

const toolUseProps = (toolUseId: string, tool = 'Agent') => ({
  plugin: 'agent-model-badge',
  surface: 'terminal',
  component: 'ToolUse',
  requestId: toolUseId,
  props: {
    tool_use_id: toolUseId,
    tool,
    input: tool === 'Agent' ? { description: 'Scan the repo', prompt: 'look around' } : { command: 'ls' },
    isRunning: true,
    isErrored: false,
    isInterrupted: false,
  },
}) as const

const stepAnswer = (e: { turnId: string; index: number }) =>
  ({ turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }) as never

// The engine beneath: the Agent call records the description it was handed and, like a real subagent, lists the
// agent under that description and runs its first request, while the call is open or after it returned.
const fold = (description: string): string => description.replace(/\s+/g, ' ').trim()

const engineBeneath = (on: On, $: Ctx, opts: { agentId: string; model: string; effort?: string; background?: boolean }) => {
  const handed: string[] = []
  on('session.model', () => ({ value: 'claude-fable-5-1' }) as never)
  on('turn.step', async function* (_$, e) {
    return stepAnswer(e)
  })
  let listed: { id: string; description: string; type: string; status: string }[] = []
  on('agent.list', () => ({ value: listed }) as never)
  const firstRequest = async () => {
    for await (const _c of $.turn.step({ turnId: 't1', index: 0, model: opts.model, effort: opts.effort, messageCount: 1, agentId: opts.agentId } as never)) {
      // drain
    }
  }
  let later: (() => Promise<void>) | undefined
  on('tool.call', { tool: 'Agent' }, async (_inner, e) => {
    const description = (e as { description: string }).description
    handed.push(description)
    listed = [{ id: opts.agentId, description: fold(description), type: 'Explore', status: 'running' }]
    if (opts.background) later = firstRequest
    else await firstRequest()
    return { result: { content: 'done' } } as never
  })
  return { handed, runLater: () => later?.() }
}

test('the description handed to the Agent tool carries the model and effort the call asked for', async ($, on) => {
  drawToolUseBeneath(on)
  const engine = engineBeneath(on, $, { agentId: 'agent-1', model: 'claude-sonnet-5-5', effort: 'low' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_desc', description: 'Scan the repo', prompt: 'look around', model: 'sonnet', effort: 'low' } as never)
  expect(engine.handed).toEqual([`Scan the repo${SEP}sonnet${SEP}low`])
})

test("a call that names no model is labelled with the session's own model", async ($, on) => {
  drawToolUseBeneath(on)
  const engine = engineBeneath(on, $, { agentId: 'agent-2', model: 'claude-fable-5-1' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_inherit', description: 'Scan the repo', prompt: 'look around' } as never)
  expect(engine.handed).toEqual([`Scan the repo${SEP}fable`])
})

test("an Agent row shows the model and effort of the agent's first request", async ($, on) => {
  drawToolUseBeneath(on)
  engineBeneath(on, $, { agentId: 'agent-3', model: 'claude-haiku-4-5-20251001', effort: 'low' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_row', description: 'Scan the repo', prompt: 'look around', model: 'haiku' } as never)
  const ui = await $.ui.mount(toolUseProps('toolu_row'))
  expect((await ui.find({ type: 'Text', text: /^haiku$/ }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^low$/ }))?.props.color).toBe('success')
  await ui.unmount()
})

test('a row of another tool is left alone', async ($, on) => {
  drawToolUseBeneath(on)
  const ui = await $.ui.mount(toolUseProps('toolu_bash', 'Bash'))
  expect(await ui.find({ type: 'Text', text: /^(sonnet|haiku|low)$/ })).toBeUndefined()
  await ui.unmount()
})

test('a notice goes under an Agent call while it is open, never after a background call returned', async ($, on) => {
  const notices: unknown[] = []
  on('ui.notice', (_$, e) => { notices.push(e); return { value: undefined } as never })
  const engine = engineBeneath(on, $, { agentId: 'agent-bg', model: 'claude-haiku-4-5-20251001', background: true })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_bg', description: 'Count', prompt: 'count', model: 'haiku' } as never)
  // The call has returned; the agent's first request comes after.
  await engine.runLater()
  expect(notices.length).toBe(0)
})

test('a foreground agent gets its notice, and a newer version of the asked-for family raises no mismatch toast', async ($, on) => {
  const notices: unknown[] = []
  const toasts: unknown[] = []
  on('ui.notice', (_$, e) => { notices.push(e); return { value: undefined } as never })
  on('ui.toast', (_$, e) => { toasts.push(e); return { value: undefined } as never })
  engineBeneath(on, $, { agentId: 'agent-fg', model: 'claude-haiku-5-5' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_fg', description: 'Count', prompt: 'count', model: 'haiku' } as never)
  expect(notices.length).toBe(1)
  expect(toasts.length).toBe(0)
})

test('an agent running on a different family than it asked for raises a toast naming both', async ($, on) => {
  const toasts: string[] = []
  on('ui.notice', () => ({ value: undefined }) as never)
  on('ui.toast', (_$, e) => { toasts.push((e as { text: string }).text); return { value: undefined } as never })
  engineBeneath(on, $, { agentId: 'agent-x', model: 'claude-sonnet-5-5' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_x', description: 'Count', prompt: 'count', model: 'haiku' } as never)
  expect(toasts).toEqual(['Count: asked for haiku, running on sonnet'])
})

test('the engine starts every agent exactly as asked: the badge never changes a spawn', async ($, on) => {
  const spawned: unknown[] = []
  on('agent.spawn', (_$, e) => { spawned.push(e); return { model: 'claude-sonnet-5-5', agentId: 'agent-s' } })
  const input = { prompt: 'look', description: 'Scan the repo', subagentType: 'Explore', parentModel: 'claude-fable-5-1', background: false, fork: false, tool_use_id: 'toolu_s' }
  await $.agent.spawn(input as never)
  expect(spawned).toEqual([input])
})

test("a subagent whose first request reports no effort shows the effort its call asked for", async ($, on) => {
  drawToolUseBeneath(on)
  engineBeneath(on, $, { agentId: 'agent-noeffort', model: 'claude-sonnet-5-5' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_noeffort', description: 'Count', prompt: 'count', model: 'sonnet', effort: 'low' } as never)
  const ui = await $.ui.mount(toolUseProps('toolu_noeffort'))
  expect(await ui.find({ type: 'Text', text: /^low$/ })).toBeDefined()
  await ui.unmount()
})

test("a later request that reports no effort keeps the effort already shown", async ($, on) => {
  drawToolUseBeneath(on)
  engineBeneath(on, $, { agentId: 'agent-keep', model: 'claude-sonnet-5-5', effort: 'high' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_keep', description: 'Count', prompt: 'count', model: 'sonnet' } as never)
  for await (const _c of $.turn.step({ turnId: 't2', index: 1, model: 'claude-sonnet-5-5', messageCount: 2, agentId: 'agent-keep' } as never)) {
    // drain
  }
  const ui = await $.ui.mount(toolUseProps('toolu_keep'))
  expect(await ui.find({ type: 'Text', text: /^high$/ })).toBeDefined()
  await ui.unmount()
})

test("an agent the engine lists only after its first request still gets its badge", async ($, on) => {
  drawToolUseBeneath(on)
  let listed: { id: string; description: string; type: string; status: string }[] = []
  on('agent.list', () => ({ value: listed }) as never)
  on('tool.call', { tool: 'Agent' }, () => ({ result: { content: 'launched' } }) as never)
  on('turn.step', async function* (_$, e) {
    return stepAnswer(e)
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_late', description: 'Count', prompt: 'count', model: 'haiku', effort: 'low' } as never)
  const step = { turnId: 't3', index: 0, model: 'claude-haiku-4-5-20251001', effort: 'low', messageCount: 1, agentId: 'agent-late' }
  for await (const _c of $.turn.step(step as never)) {
    // drain
  }
  listed = [{ id: 'agent-late', description: `Count${SEP}haiku${SEP}low`, type: 'Explore', status: 'running' }]
  for await (const _c of $.turn.step({ ...step, index: 1, messageCount: 2 } as never)) {
    // drain
  }
  const ui = await $.ui.mount(toolUseProps('toolu_late'))
  expect(await ui.find({ type: 'Text', text: /^haiku$/ })).toBeDefined()
  await ui.unmount()
})

const stepAs = async ($: Ctx, agentId: string | undefined, model: string, effort?: string, index = 0) => {
  for await (const _c of $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index, model, effort, messageCount: index + 1, agentId } as never)) {
    // drain
  }
}

const listedAs = (id: string, description: string): Listed => ({ id, description: fold(description), type: 'Explore', status: 'running' })

// The engine beneath for tests that drive the agents' requests themselves.
const listingEngine = (on: On) => {
  const state = { listed: [] as Listed[] }
  on('session.model', () => ({ value: 'claude-fable-5-1' }) as never)
  on('turn.step', async function* (_$, e) {
    return stepAnswer(e)
  })
  on('agent.list', () => ({ value: state.listed }) as never)
  return { list: (...agents: Listed[]) => { state.listed = agents } }
}

// An Agent call that returns at once with its agent running in the background.
const launchedEngine = (on: On) => {
  const handed: string[] = []
  const engine = listingEngine(on)
  on('tool.call', { tool: 'Agent' }, (_$, e) => {
    handed.push((e as { description: string }).description)
    return { result: { status: 'async_launched', agentId: 'unused', description: '', prompt: '', outputFile: '' } } as never
  })
  return { handed, list: engine.list }
}

const rowShows = async ($: Ctx, toolUseId: string, text: RegExp): Promise<boolean> => {
  const ui = await $.ui.mount(toolUseProps(toolUseId))
  const found = (await ui.find({ type: 'Text', text })) !== undefined
  await ui.unmount()
  return found
}

test('a retried Agent call gets the badge and the notice when the call before it was denied', async ($, on) => {
  const notices = drawToolUseBeneath(on)
  const engine = listingEngine(on)
  let attempts = 0
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    attempts += 1
    if (attempts === 1) return { deny: 'not allowed' } as never
    engine.list(listedAs('agent-retry', (e as { description: string }).description))
    await stepAs($, 'agent-retry', 'claude-haiku-4-5-20251001', 'low')
    return { result: { status: 'completed' } } as never
  })
  const call = (id: string) => ({ tool: 'Agent', tool_use_id: id, description: 'Retry me', prompt: 'look', model: 'haiku' }) as never
  await $.tool.call(call('toolu_denied'))
  await $.tool.call(call('toolu_retry'))
  expect(notices.map(n => n.tool_use_id)).toEqual(['toolu_retry'])
  expect(await rowShows($, 'toolu_retry', /^haiku$/)).toBe(true)
  expect(await rowShows($, 'toolu_denied', /^haiku$/)).toBe(false)
})

test('an agent whose call description holds a run of spaces still gets its badge', async ($, on) => {
  drawToolUseBeneath(on)
  engineBeneath(on, $, { agentId: 'agent-fold', model: 'claude-haiku-4-5-20251001' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_fold', description: 'Count  lines', prompt: 'count', model: 'haiku' } as never)
  expect(await rowShows($, 'toolu_fold', /^haiku$/)).toBe(true)
})

const EFFORT_COLORS = { low: 'success', medium: 'ide', high: 'warning', xhigh: 'claude', max: 'error' } as const
for (const [level, color] of Object.entries(EFFORT_COLORS)) {
  test(`an Agent row draws the ${level} effort in the ${color} colour`, async ($, on) => {
    drawToolUseBeneath(on)
    engineBeneath(on, $, { agentId: `agent-level-${level}`, model: 'claude-fable-5-1', effort: level })
    await $.tool.call({ tool: 'Agent', tool_use_id: `toolu_level_${level}`, description: `Scan ${level}`, prompt: 'look', model: 'fable' } as never)
    const ui = await $.ui.mount(toolUseProps(`toolu_level_${level}`))
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${level}$`) }))?.props.color).toBe(color)
    await ui.unmount()
  })
}

test('a call that names no effort is labelled with the effort its model family last ran at', async ($, on) => {
  const engine = launchedEngine(on)
  await stepAs($, undefined, 'claude-opus-5-5', 'medium')
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_family', description: 'Plan it', prompt: 'plan', model: 'opus' } as never)
  expect(engine.handed).toEqual([`Plan it${SEP}opus${SEP}medium`])
})

test('a later request at a new effort updates the row and the notice under the open call', async ($, on) => {
  const notices = drawToolUseBeneath(on)
  const engine = listingEngine(on)
  on('tool.call', { tool: 'Agent' }, async (_$, e) => {
    engine.list(listedAs('agent-shift', (e as { description: string }).description))
    await stepAs($, 'agent-shift', 'claude-sonnet-5-5', 'low')
    await stepAs($, 'agent-shift', 'claude-sonnet-5-5', 'high', 1)
    return { result: { status: 'completed' } } as never
  })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_shift', description: 'Shift effort', prompt: 'go', model: 'sonnet' } as never)
  expect(notices).toEqual([
    { tool_use_id: 'toolu_shift', text: `model: sonnet${SEP}low` },
    { tool_use_id: 'toolu_shift', text: `model: sonnet${SEP}high` },
  ])
  const ui = await $.ui.mount(toolUseProps('toolu_shift'))
  expect((await ui.find({ type: 'Text', text: /^high$/ }))?.props.color).toBe('warning')
  await ui.unmount()
})

for (const [first, second] of [['twin-a', 'twin-b'], ['twin-b', 'twin-a']] as const) {
  test(`two calls with one description each get a badge when ${first} makes its request before ${second}`, async ($, on) => {
    drawToolUseBeneath(on)
    const engine = launchedEngine(on)
    const effortOf = { 'twin-a': 'low', 'twin-b': 'high' }
    const agentId = (who: string) => `${who}-under-${first}-first`
    for (const n of [1, 2]) {
      await $.tool.call({ tool: 'Agent', tool_use_id: `toolu_${first}_${n}`, description: `Twins ${first} first`, prompt: 'go', model: 'sonnet' } as never)
    }
    engine.list(listedAs(agentId(first), engine.handed[0] ?? ''), listedAs(agentId(second), engine.handed[1] ?? ''))
    await stepAs($, agentId(first), 'claude-sonnet-5-5', effortOf[first])
    await stepAs($, agentId(second), 'claude-sonnet-5-5', effortOf[second])
    expect(await rowShows($, `toolu_${first}_1`, new RegExp(`^${effortOf[first]}$`))).toBe(true)
    expect(await rowShows($, `toolu_${first}_2`, new RegExp(`^${effortOf[second]}$`))).toBe(true)
  })
}

test('an agent the engine does not list in three requests is given up on, leaving its call for the agent that is listed', async ($, on) => {
  drawToolUseBeneath(on)
  const engine = launchedEngine(on)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_lost', description: 'Lost and found', prompt: 'go', model: 'haiku' } as never)
  for (const index of [0, 1, 2]) await stepAs($, 'agent-lost', 'claude-haiku-4-5-20251001', 'low', index)
  engine.list(listedAs('agent-lost', engine.handed[0] ?? ''))
  await stepAs($, 'agent-lost', 'claude-haiku-4-5-20251001', 'low', 3)
  expect(await rowShows($, 'toolu_lost', /^haiku$/)).toBe(false)
  engine.list(listedAs('agent-found', engine.handed[0] ?? ''))
  await stepAs($, 'agent-found', 'claude-haiku-4-5-20251001', 'low')
  expect(await rowShows($, 'toolu_lost', /^haiku$/)).toBe(true)
})

test('a fork is labelled with the session model, not the model its call names, and raises no mismatch toast', async ($, on) => {
  drawToolUseBeneath(on)
  const toasts: unknown[] = []
  on('ui.toast', (_$, e) => { toasts.push(e); return { value: undefined } as never })
  const engine = engineBeneath(on, $, { agentId: 'agent-fork', model: 'claude-fable-5-1' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_fork', subagent_type: 'fork', description: 'Branch off', prompt: 'go', model: 'haiku', effort: 'low' } as never)
  expect(engine.handed).toEqual([`Branch off${SEP}fable`])
  expect(toasts).toEqual([])
})

test("a call made inside a subagent that names no model is labelled with that subagent's model", async ($, on) => {
  drawToolUseBeneath(on)
  const engine = launchedEngine(on)
  await $.tool.call({ tool: 'Agent', tool_use_id: 'toolu_parent', description: 'Parent job', prompt: 'go', model: 'opus' } as never)
  engine.list(listedAs('agent-parent', engine.handed[0] ?? ''))
  await stepAs($, 'agent-parent', 'claude-opus-5-5', 'medium')
  await $.tool.call({ tool: 'Agent', agentId: 'agent-parent', tool_use_id: 'toolu_child', description: 'Child job', prompt: 'go' } as never)
  expect(engine.handed[1]).toBe(`Child job${SEP}opus${SEP}medium`)
})
