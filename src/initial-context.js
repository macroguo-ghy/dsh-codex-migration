import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { installContextWorkflow, currentChoice, writeChoice } from './context-workflow.js'

// This local, model-free retry rebuilds a LOOP request from the changed native
// surface. The frozen llm/stream request is never edited or sent to an adapter.
const PREPARE = 'CODEX_INITIAL_CONTEXT_PREPARE'
const BEGIN = 'plugin:codex-migration/context-prepare'
const FACTOR = 1.15

function limits(ctx, state, request) {
  const { session, agent } = state
  const window = session.requestContext()?.contextWindow
  if (!Number.isSafeInteger(window) || window <= 0) throw new Error('无法确认模型生效窗口，首次 Codex 续聊已停止。请配置或选择已知的大窗口模型。')
  const outputReserve = request.maxTokens ?? 0
  const margin = Math.min(2048, Math.ceil(window * 0.01))
  let threshold = window - outputReserve
  const engine = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
  if (engine) {
    const policy = engine.config
    if (typeof policy?.auto !== 'boolean' || !Array.isArray(policy.modelPolicies)) {
      throw new Error('无法确认当前压缩引擎的生效阈值，首次 Codex 续聊已停止。需要 DSH 原生 basic 压缩引擎。')
    }
    if (policy.auto) {
      const override = policy.modelPolicies.find(p => p.provider === request.provider && p.model === request.model)
      const ratio = override?.thresholdRatio ?? policy.thresholdRatio
      const headroom = override?.headroomTokens ?? policy.headroomTokens
      threshold = Math.min(threshold, Math.floor(Math.min(window * ratio, window - outputReserve - headroom)) - 1)
    }
  }
  if (!Number.isFinite(threshold)) throw new Error('无法确认首次 Codex 续聊预算，请检查模型窗口和压缩配置。')
  return { window, outputReserve, margin, threshold, budget: threshold - margin }
}

function candidates(session, checkpoint, measurement) {
  const prices = new Map(measurement.nodes.map(node => [node.seq, node]))
  const importedResults = new Set(session.snapshotEvents(0, checkpoint + 1)
    .filter(event => event.type === 'tool/result').map(event => event.data.message.id))
  const results = new Map()
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    // Native pruning can give an imported result a newer seq. Its immutable
    // identity and turn still identify it; call IDs may repeat in later turns.
    if (event.type === 'tool/result' && importedResults.has(event.data.message.id)) {
      results.set(event.data.turn + ':' + event.data.message.toolCallId, event)
    }
  }
  const pairs = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (seq > checkpoint || event.type !== 'assistant/message' || event.data.message.source.provider !== 'codex') continue
    const content = session.deriveEventMessage(event)?.content
    // Never shadow a message containing prose or readable reasoning. New imports
    // give reasoning its own native message before each tool-only message.
    if (content?.length !== 1 || content[0].type !== 'tool-call') continue
    const call = content[0], result = results.get(event.data.turn + ':' + call.id)
    if (!result || !prices.has(seq) || !prices.has(result.seq)) continue
    pairs.push({ callId: call.id, name: call.name, assistantSeq: seq, resultSeq: result.seq,
      turn: event.data.turn, time: event.time,
      tokens: prices.get(seq).tokens + prices.get(result.seq).tokens })
  }
  return pairs
}

function omissionNotice(pairs, id) {
  const counts = new Map()
  for (const pair of pairs) counts.set(pair.name, (counts.get(pair.name) ?? 0) + 1)
  const names = [...counts].slice(0, 32).map(([name, count]) => name.slice(0, 80) + ' × ' + count).join('；')
    + (counts.size > 32 ? '；另有 ' + (counts.size - 32) + ' 类工具（见完整省略记录）' : '')
  return { id, role: 'user', source: { kind: 'codex-imported-context', form: 'notice' }, content: [{ type: 'text',
    text: '[Codex 迁移续聊上下文] 已省略 ' + pairs.length + ' 对旧工具调用与结果，未生成摘要。'
      + '真人 prompt 和历史模型正文原文保留，可读推理及完整工具原记录仍保存在会话历史中。'
      + '省略范围：原历史第 ' + pairs[0].turn + '–' + pairs.at(-1).turn + ' 轮；' + names + '。'
      + '省略的工具内容不能作为已经掌握的事实；需要时用当前工具重新核实。完整原记录仍在会话历史中。' }] }
}

function tooLarge(estimated, budget) {
  return new Error('首次 Codex 续聊上下文仍超限：保留内容约 ' + estimated.toLocaleString('zh-CN')
    + ' token，可用预算 ' + Math.max(0, budget).toLocaleString('zh-CN')
    + ' token（已计入输出预留和原生自动压缩阈值）。请换更大上下文窗口的模型或提高生效窗口后重试；未发送模型请求，也未生成摘要。')
}

function prepare(ctx, state, turn, step) {
  const { session, checkpoint, pending } = state
  const meter = ctx.tokenMeter
  const measurement = meter.measure(session)
  const available = candidates(session, checkpoint, measurement)
  const omitted = []
  let remaining = measurement.totalTokens, notice
  for (const pair of available) {
    omitted.push(pair)
    remaining -= pair.tokens
    notice = omissionNotice(omitted, 'codex-omitted-tools-' + session.seq)
    if (Math.ceil((remaining + meter.estimateMessage(notice)) * FACTOR) <= pending.budget) break
  }
  if (!omitted.length) throw tooLarge(Math.ceil(remaining * FACTOR), pending.budget)
  const plan = { ...pending, checkpoint, preparationId: session.seq, omitted, notice,
    retainedPairs: available.length - omitted.length }
  appendPluginRecord(session, BEGIN, plan)
  finishPreparation(ctx, state, plan, turn, step)
  const estimated = Math.ceil(meter.measure(session).totalTokens * FACTOR)
  state.pending = undefined
  if (estimated > pending.budget) throw tooLarge(estimated, pending.budget)
}

function finishPreparation(ctx, state, plan, turn, step) {
  const { session } = state
  const meter = ctx.tokenMeter
  const measurement = meter.measure(session)
  const prices = new Map(measurement.nodes.map(node => [node.seq, node]))
  const current = new Map(session.surface.nodes.map(seq => {
    const event = session.eventAt(seq)
    const message = event.type === 'user/message' ? event.data : event.data.message
    return [message.id, event]
  }))
  // Recovery finds current identities, including native tool-result rewrites.
  // A crash between the two replacements is completed before a new request.
  // No owner-specific interpreter is needed to reconstruct either replacement.
  const { omitted, notice } = plan
  for (const pair of omitted) {
    for (const originalSeq of [pair.assistantSeq, pair.resultSeq]) {
      const original = session.eventAt(originalSeq)
      const event = current.get(original.data.message.id)
      if (!event) continue
      const seq = event.seq, price = prices.get(seq)
      session.append('compaction/prune', { shadowedRange: { start: seq, end: seq }, shadowedSeqs: [seq], shadowedTokenCount: price.heuristicTokens })
      session.append('developer/message', { turn, step, message: {
        id: 'codex-omitted-node-' + seq, role: 'developer', content: [], source: { kind: 'codex-imported-context', form: 'notice' },
      } }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
      current.delete(original.data.message.id)
    }
  }
  if (!current.has(notice.id)) session.append('user/message', notice, { surfaceOp: 'append' })
  const estimated = Math.ceil(meter.measure(session).totalTokens * FACTOR)
  const { notice: _notice, ...receipt } = plan
  appendPluginRecord(session, 'plugin:codex-migration/request-budget', {
    ...receipt, estimated, factor: FACTOR, phase: 'initial',
    timeRange: { start: omitted[0].time, end: omitted.at(-1).time },
    ...(session.header.origin === 'subagent' ? { address: { kind: 'subagent', parentSessionId: session.header.parentSession,
      childSessionId: session.id, mode: 'continuable' } } : {}),
  })
}

export function installInitialContext(ctx) {
  const states = new Map()
  const stateFor = agent => {
    const session = agent.session
    let state = states.get(session.id)
    if (state?.ready) return state
    const events = session.snapshotEvents()
    const checkpoint = events.findLast(e => e.type === 'codex-migration/checkpoint')?.seq
    if (checkpoint === undefined) state = { session, ready: true }
    else {
      const ready = events.some(e => e.seq > checkpoint && e.type === 'assistant/message' && !e.data.interrupted)
      const begun = events.findLast(e => e.seq > checkpoint && e.type === BEGIN)
      const ended = begun && events.some(e => e.type === 'plugin:codex-migration/request-budget' && e.data.preparationId === begun.data.preparationId)
      state = { ...state, session, agent, checkpoint, ready, recovery: begun && !ended ? begun.data : undefined }
      state.limits = request => limits(ctx, state, request)
    }
    states.set(session.id, state)
    return state
  }
  const workflow = installContextWorkflow(ctx, stateFor)
  ctx.on('session/disposed', session => { if (states.get(session.id)?.session === session) states.delete(session.id) })
  ctx.on('session/event', (session, event) => {
    const state = states.get(session.id)
    if (state?.session === session && !state.ready && event.type === 'turn/end'
      && ['error', 'aborted'].includes(event.data.reason.kind)) {
      const choice = currentChoice(session)
      if (choice && ['resuming', 'summarizing'].includes(choice.status)) queueMicrotask(() => {
        const latest = currentChoice(session)
        if (states.get(session.id) === state && latest?.id === choice.id && ['resuming', 'summarizing'].includes(latest.status)) {
          writeChoice(session, latest, { status: event.data.reason.kind === 'aborted' ? 'cancelled' : 'error',
            reason: event.data.reason.error?.message ?? '已取消续聊，原输入与摘要进度均保留。' })
        }
      })
    }
    if (state?.session === session && !state.ready && event.seq > state.checkpoint
      && event.type === 'assistant/message' && !event.data.interrupted) {
      // Observe the committed settlement, without appending from an observer.
      state.ready = true
      state.pending = undefined
      const choice = currentChoice(session)
      if (choice && ['resuming', 'pending'].includes(choice.status)) queueMicrotask(() => {
        if (states.get(session.id) === state) writeChoice(session, currentChoice(session), { status: 'ready', reason: '已完成首次续聊，后续使用 DSH 原生自动压缩。上方失败提示属于准备阶段的历史记录，本次已恢复续聊。' })
      })
    }
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    stateFor(agent)
    return next()
  }, { prepend: true })
  ctx.on('agent/request', async ({ agent, turn, step }, next) => {
    const state = states.get(agent.session.id)
    if (state?.recovery && !state.ready) {
      finishPreparation(ctx, state, state.recovery, turn, step)
      state.recovery = undefined
    }
    if (state && !state.ready) {
      const { recoverSummary } = await import('./context-summary.js')
      await recoverSummary(ctx, state)
    }
    return next()
  }, { prepend: true })
  ctx.on('llm/stream', async function* (request, next) {
    const state = states.get(request.sessionId)
    if (!state || state.ready) return yield* next()
    // A failed first admission leaves a request/header. On retry or a model
    // switch basic compaction may inspect that header before final admission.
    // Refuse its auxiliary model call until the first continuation succeeds.
    if (request.purpose === 'compaction') {
      if (state.nativeSummary) return yield* state.nativeSummary(request, next)
      throw new Error('首次续聊需要先选择更大窗口模型或摘要后续聊。')
    }
    if (!isAgentLoopRequest(request)) return yield* next()
    const envelope = limits(ctx, state, request)
    const estimated = Math.ceil(ctx.tokenMeter.measure(state.session).totalTokens * FACTOR)
    if (estimated > envelope.budget || currentChoice(state.session)?.status === 'summarizing') {
      state.pending = envelope
      yield { type: 'finish', reason: { kind: 'error', failure: { code: PREPARE, message: '正在准备迁移历史的续聊上下文' } } }
      return
    }
    const choice = currentChoice(state.session)
    if (choice?.status === 'resuming') writeChoice(state.session, choice, {
      ...envelope, estimated, reason: '窗口检查通过，正在恢复续聊。',
    })
    yield* next()
  }, { prepend: true })
  ctx.on('agent/request-error', async ({ agent, failure, turn, step, signal }, next) => {
    const state = states.get(agent.session.id)
    if (failure.code === 'CONTEXT_WINDOW_EXCEEDED' && state && !state.ready) {
      workflow.offer(state, { ...limits(ctx, state, agent.session.requestHeader().config), providerRejected: true }, '模型返回上下文超限，请选择更大窗口模型或摘要后续聊。')
      throw new Error('请换更大上下文窗口模型，或在续聊选择卡片中选择摘要后续聊。')
    }
    if (failure.code !== PREPARE || !state?.pending || state.ready) return next()
    if (currentChoice(agent.session)?.status === 'summarizing') {
      await workflow.summarize(state, signal)
      state.pending = undefined
      return { kind: 'retry' }
    }
    try { prepare(ctx, state, turn, step) }
    catch (error) {
      if (!error.message.startsWith('首次 Codex 续聊上下文仍超限')) throw error
      workflow.offer(state, state.pending ?? limits(ctx, state, agent.session.requestHeader().config), error.message)
      throw new Error('请换更大上下文窗口模型，或在续聊选择卡片中选择摘要后续聊。')
    }
    return { kind: 'retry' }
  }, { prepend: true })
  return () => workflow.busy()
}
