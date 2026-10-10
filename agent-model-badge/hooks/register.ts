import type { EngineInterface, Register, RenderElement } from 'claude-code'

type Badge = {
  toolUseId: string
  model: string
  effort?: string
}

const SHORT: Record<string, string> = {
  'claude-fable-5-1': 'fable',
  'claude-opus-5-5': 'opus',
  'claude-sonnet-5-5': 'sonnet',
  'claude-haiku-4-5-20251001': 'haiku',
}

// agentId → badge; module state resets on reload, which is fine for a live view.
const byAgent = new Map<string, Badge>()

// The family name, so a new version of a model (claude-haiku-5-5) still reads as the haiku that was asked for.
const shortModel = (id: string): string =>
  SHORT[id] ?? /^claude-([a-z]+)/.exec(id)?.[1] ?? id

// One colour per effort level, from the engine's theme keys; the same ones the dock's effort chips use.
const EFFORT_COLOR: Record<string, 'success' | 'ide' | 'warning' | 'claude' | 'error'> = {
  low: 'success',
  medium: 'ide',
  high: 'warning',
  xhigh: 'claude',
  max: 'error',
}

// A wide middle dot keeps the label clear of the description: "Count lines  ·  sonnet  ·  low". The engine folds
// any run of whitespace in a task's description, so each side pairs a space with a braille blank (U+2800),
// which draws as an empty cell but is not whitespace.
const SEP = ' \u2800·\u2800 '
const badgeText = (b: Badge): string =>
  `${shortModel(b.model)}${b.effort ? `${SEP}${b.effort}` : ''}`

// The effort each model family last ran at here, for a spawn whose call names none.
const effortByFamily = new Map<string, string>()

function refreshNotice($: EngineInterface, toolUseId: string): void {
  if (!openCalls.has(toolUseId)) return
  const row = [...byAgent.values()].find(b => b.toolUseId === toolUseId)
  if (!row) return
  try {
    $.ui.notice(toolUseId, `model: ${badgeText(row)}`)
  } catch {
    // the call may already be closed (a resumed workflow run); nothing to draw under
  }
}

// What each Agent call asked for, by tool_use_id, and which call each labelled description came from: the
// engine lists a running agent by its description, which is how a subagent's first request finds its call.
const requested = new Map<string, { model?: string; effort?: string }>()
// Calls still waiting for their agent, by description, oldest first: two calls with one description take turns.
const callsByDescription = new Map<string, string[]>()
// The engine lists a description with every run of whitespace folded to one space, so the queues are keyed by that.
const slotOf = (description: string): string => description.replace(/\s+/g, ' ').trim()
// Lookups an agent has failed so far. The engine can list an agent a moment after its first request, so a miss
// is retried on the next request and given up after a few.
const misses = new Map<string, number>()
const MAX_MISSES = 3
// Agent calls still running. A notice can only sit under an open call: a background agent's call returns at
// once, and a notice sent after that is dropped with a line in the transcript.
const openCalls = new Set<string>()

// A subagent's first request: find the Agent call that started it and give its row a badge.
async function adopt($: EngineInterface, agentId: string, model: string, effort: string | undefined): Promise<void> {
  if ((misses.get(agentId) ?? 0) >= MAX_MISSES) return
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const toolUseId = info ? callsByDescription.get(slotOf(info.description))?.shift() : undefined
  const ask = toolUseId ? requested.get(toolUseId) : undefined
  if (!info || !toolUseId || !ask) {
    misses.set(agentId, (misses.get(agentId) ?? 0) + 1)
    return
  }
  misses.delete(agentId)
  const label = info.name ?? info.description.split(SEP)[0] ?? info.type
  byAgent.set(agentId, {
    toolUseId,
    model,
    effort: effort ?? ask.effort ?? effortByFamily.get(shortModel(model)),
  })
  if (ask.model && shortModel(model) !== ask.model) {
    $.ui.toast(`${label}: asked for ${ask.model}, running on ${shortModel(model)}`)
  }
  refreshNotice($, toolUseId)
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  // The tasks list above the prompt draws the call's description, so the label rides in it: the model the
  // call names, else the session's own, and the effort the call names, else the one that model last ran at.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const id = e.tool_use_id
    if (!id || !e.description) return next(e)
    // A fork inherits its parent's model and effort, whatever the call names.
    const named: { model?: string; effort?: string } = e.subagent_type === 'fork' ? {} : { model: e.model, effort: e.effort }
    const parentModel = e.agentId ? byAgent.get(e.agentId)?.model : undefined
    const asked = named.model ?? shortModel(parentModel ?? (await $.session.model()))
    const effort = named.effort ?? effortByFamily.get(shortModel(asked))
    const input = { ...e, description: `${e.description}${SEP}${asked}${effort ? `${SEP}${effort}` : ''}` }
    const slot = slotOf(input.description)
    requested.set(id, named)
    const queue = callsByDescription.get(slot) ?? []
    queue.push(id)
    callsByDescription.set(slot, queue)
    openCalls.add(id)
    let done: { deny?: string; isError?: boolean; result?: unknown } | undefined
    try {
      const out = await next(input)
      done = out
      return out
    } finally {
      openCalls.delete(id)
      // A call that started no agent must not keep its place in the queue; a background launch keeps it for its agent.
      if (!done || done.deny !== undefined || done.isError || (done.result as { status?: string } | null | undefined)?.status === 'completed') {
        const waiting = callsByDescription.get(slot)
        const at = waiting?.indexOf(id) ?? -1
        if (at >= 0) waiting?.splice(at, 1)
        requested.delete(id)
      }
    }
  })

  on('turn.step', async function* ($, e, next) {
    if (e.effort !== undefined) effortByFamily.set(shortModel(e.model), String(e.effort))
    // A request that reports no effort keeps the one already shown: only a reported level changes it.
    const effort = e.effort === undefined ? undefined : String(e.effort)
    if (e.agentId) {
      const badge = byAgent.get(e.agentId)
      if (!badge) {
        try {
          await adopt($, e.agentId, e.model, effort)
        } catch {
          // the agent list is a lookup; the request goes on regardless
        }
      } else {
        const shownEffort = effort ?? badge.effort
        if (badge.model !== e.model || badge.effort !== shownEffort) {
          badge.model = e.model
          badge.effort = shownEffort
          refreshNotice($, badge.toolUseId)
          $.ui.invalidate('ui.render')
        }
      }
    }
    return yield* next(e)
  })

  // The Agent tool's transcript row: the engine's own drawing, then the badge beside it,
  // the model in white and the effort in its level's colour.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.component !== 'ToolUse' || e.props.tool !== 'Agent') return next(e)
    const badge = [...byAgent.values()].find(b => b.toolUseId === e.props.tool_use_id)
    if (!badge) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const theirs = await next(e)
    return h(
      Box,
      { flexDirection: 'row', columnGap: 1 },
      theirs ?? '',
      h(Text, { bold: true, color: 'text' }, shortModel(badge.model)),
      badge.effort ? h(Text, { bold: true, color: EFFORT_COLOR[badge.effort] ?? 'text' }, badge.effort) : null,
    ) as RenderElement
  })
}
