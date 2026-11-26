import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { isFilteredHistory, quotedSources, quoteHistory } from './filtered-history.js'
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
  let compressionLimit
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
      compressionLimit = { ratio, headroom, trigger: Math.floor(Math.min(window * ratio, window - outputReserve - headroom)) }
      threshold = Math.min(threshold, compressionLimit.trigger - 1)
    }
  }
  if (!Number.isFinite(threshold)) throw new Error('无法确认首次 Codex 续聊预算，请检查模型窗口和压缩配置。')
  return { window, outputReserve, ...(compressionLimit && { compressionLimit }), margin, threshold, budget: threshold - margin }
}

function candidates(session, checkpoint, measurement) {
  const prices = new Map(measurement.nodes.map(node => [node.seq, node]))
  const imported = new Set()
  let inBatch = false
  for (const event of session.snapshotEvents(0, checkpoint + 1)) {
    if (event.type === 'codex-migration/begin') inBatch = true
    else if (event.type === 'codex-migration/checkpoint') inBatch = false
    else if (inBatch && ['assistant/message', 'tool/result'].includes(event.type)) imported.add(event.data.message.id)
  }
  const traces = [], results = new Map(), reasoning = []
  for (const seq of session.surface.nodes) {
    const event = session.eventAt(seq)
    if (!imported.has(event.data.message?.id)) continue
    if (event.type === 'tool/result') {
      const msg = event.data.message
      results.set(event.data.turn + ':' + msg.toolCallId, { callId: msg.toolCallId, name: msg.toolName || '工具结果',
        resultSeq: seq, turn: event.data.turn, time: event.time, tokens: prices.get(seq)?.tokens ?? 0 })
    } else if (event.type === 'assistant/message') {
      const content = session.deriveEventMessage(event)?.content ?? []
      if (content.some(block => block.type === 'reasoning')) reasoning.push(seq)
      for (const block of content) if (block.type === 'tool-call') {
        traces.push({ callId: block.id, name: block.name, assistantSeq: seq, resultSeq: undefined,
          turn: event.data.turn, time: event.time, tokens: prices.get(seq)?.tokens ?? 0 })
      }
    }
  }
  for (const trace of traces) {
    const key = trace.turn + ':' + trace.callId, result = results.get(key)
    if (result) { trace.resultSeq = result.resultSeq; trace.tokens += result.tokens; results.delete(key) }
  }
  return { omitted: [...traces, ...results.values()], reasoning }
}

function omissionNotice(id) {
  return { id, role: 'user', source: { kind: 'codex-imported-context', form: 'notice' }, content: [{ type: 'text',
    text: '[Codex 迁移续聊上下文] 已省略导入的历史推理、旧工具调用与结果，未生成摘要。完整记录可在会话历史中查看。'
      + '仅使用本轮提供的工具及参数；需要工具结果时请重新核实。' }] }
}

function tooLarge(estimated, budget) {
  return new Error('首次 Codex 续聊上下文仍超限：保留内容约 ' + estimated.toLocaleString('zh-CN')
    + ' token，可用预算 ' + Math.max(0, budget).toLocaleString('zh-CN')
    + ' token（已计入输出预留和原生自动压缩阈值）。请换更大上下文窗口的模型或提高生效窗口后重试；未发送模型请求，也未生成摘要。')
}

function prepare(ctx, state, turn, step, summarizing) {
  const { session, checkpoint, pending } = state
  const meter = ctx.tokenMeter
  const measurement = meter.measure(session)
  const { omitted, reasoning } = candidates(session, checkpoint, measurement)
  if (!omitted.length && !reasoning.length) {
    if (summarizing) return
    throw tooLarge(Math.ceil(measurement.totalTokens * FACTOR), pending.budget)
  }
  const notice = omissionNotice('codex-omitted-tools-' + session.seq)
  const plan = { ...pending, checkpoint, preparationId: session.seq, omitted, reasoning, notice,
    allImportedTools: true, retainedPairs: 0 }
  appendPluginRecord(session, BEGIN, plan)
  finishPreparation(ctx, state, plan, turn, step)
  const estimated = Math.ceil(meter.measure(session).totalTokens * FACTOR)
  state.pending = undefined
  if (!summarizing && estimated > pending.budget) throw tooLarge(estimated, pending.budget)
}

function finishPreparation(ctx, state, plan, turn, step) {
  const { session } = state
  const meter = ctx.tokenMeter
  const { omitted, notice } = plan
  const targets = new Set(omitted.flatMap(pair => [pair.assistantSeq, pair.resultSeq]).filter(Number.isInteger))
  for (const seq of plan.reasoning ?? []) targets.add(seq)
  // Only compact a contiguous run of migration-owned nodes. Native messages,
  // the system head, and earlier summary replacements remain independent.
  const imported = new Set()
  let inBatch = false
  for (const event of session.snapshotEvents(0, plan.checkpoint + 1)) {
    if (event.type === 'codex-migration/begin') inBatch = true
    else if (event.type === 'codex-migration/checkpoint') inBatch = false
    else if (inBatch && event.surfaceOp === 'append' && event.type !== 'system/message') imported.add(event.seq)
  }
  // A native rewrite can move a tool result beyond its original import batch.
  const targetIds = new Set([...targets].map(seq => session.eventAt(seq).data.message.id))
  const nodes = [...session.surface.nodes]
  let first = -1, last = -1
  function replaceRun() {
    if (first < 0) return
    const seqs = nodes.slice(first, last + 1)
    const content = quoteHistory(session, seqs)
    const replace = { surfaceOp: { op: /** @type {const} */ ('replace'), startSeq: seqs[0], endSeq: seqs.at(-1) }, sourceEventSeqs: seqs }
    // The native range replacement is the atomic commit. A retry sees only
    // the replacement, so it cannot apply the same range twice.
    if (content.length) session.append('user/message', {
      id: 'codex-filtered-history-' + seqs[0], role: 'user', source: { kind: 'codex-imported-context', form: 'notice' },
      content,
    }, replace)
    else session.append('developer/message', { turn, step, message: {
      id: 'codex-omitted-node-' + seqs[0], role: 'developer', content: [], source: { kind: 'codex-imported-context', form: 'notice' },
    } }, replace)
    first = last = -1
  }
  for (const [index, seq] of nodes.entries()) {
    const event = session.eventAt(seq)
    if (targetIds.has(event.data.message?.id)) {
      if (first < 0) first = index
      last = index
    } else if (!imported.has(seq) || (!plan.allImportedTools &&
      (event.type === 'tool/result' || event.data.message?.content.some(block => block.type === 'tool-call')))) {
      // Older unfinished plans can select only a subset of the tool calls.
      // Preserve unselected calls as native nodes until a fresh admission.
      replaceRun()
    }
  }
  replaceRun()
  if (!nodes.some(seq => session.eventAt(seq).data.id === notice.id)) session.append('user/message', notice, { surfaceOp: 'append' })
  const estimated = Math.ceil(meter.measure(session).totalTokens * FACTOR)
  const { notice: _notice, ...receipt } = plan
  appendPluginRecord(session, 'plugin:codex-migration/request-budget', {
    ...receipt, estimated, factor: FACTOR, phase: 'initial',
    ...(omitted.length && { timeRange: { start: omitted[0].time, end: omitted.at(-1).time } }),
    ...(session.header.origin === 'subagent' ? { address: { kind: 'subagent', parentSessionId: session.header.parentSession,
      childSessionId: session.id, mode: 'continuable' } } : {}),
  })
}

// An older preparation may have quoted reasoning as ordinary user text.
// Rebuild only recorded migration ranges, using their exact source seqs.
function repairPreparedHistory(session, turn, step) {
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    const original = isFilteredHistory(event) ? quotedSources(session, event) : [seq]
    if (!original?.some(index => {
      const message = session.eventAt(index).data.message
      return message?.source?.provider === 'codex' && message.id?.startsWith('codex-message-')
        && message.content.some(block => block.type === 'reasoning')
    })) continue
    const content = quoteHistory(session, original)
    if (isFilteredHistory(event) && JSON.stringify(content) === JSON.stringify(event.data.content)) continue
    const replacement = { surfaceOp: { op: /** @type {const} */ ('replace'), startSeq: seq, endSeq: seq }, sourceEventSeqs: isFilteredHistory(event) ? [...original, seq] : original }
    const source = { kind: /** @type {const} */ ('codex-imported-context'), form: /** @type {const} */ ('notice') }
    if (content.length) session.append('user/message', { id: 'codex-filtered-history-upgrade-' + seq, role: 'user', source, content }, replacement)
    else session.append('developer/message', { turn, step, message: { id: 'codex-omitted-node-upgrade-' + seq,
      role: 'developer', source, content: [] } }, replacement)
  }
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
    if (state?.checkpoint !== undefined && !state.checkedLegacy) {
      const receipt = state.session.snapshotEvents().findLast(event => event.seq > state.checkpoint && event.type === 'plugin:codex-migration/request-budget')
      if ((state.ready || receipt) && !receipt?.data.reasoning) repairPreparedHistory(state.session, turn, step)
      state.checkedLegacy = true
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
    const measurement = ctx.tokenMeter.measure(state.session)
    const estimated = Math.ceil(measurement.totalTokens * FACTOR)
    const { omitted, reasoning } = candidates(state.session, state.checkpoint, measurement)
    if (omitted.length || reasoning.length || estimated > envelope.budget || currentChoice(state.session)?.status === 'summarizing') {
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
    const summarizing = currentChoice(agent.session)?.status === 'summarizing'
    try { prepare(ctx, state, turn, step, summarizing) }
    catch (error) {
      if (!error.message.startsWith('首次 Codex 续聊上下文仍超限')) throw error
      workflow.offer(state, state.pending ?? limits(ctx, state, agent.session.requestHeader().config), error.message)
      throw new Error('请换更大上下文窗口模型，或在续聊选择卡片中选择摘要后续聊。')
    }
    if (summarizing) {
      await workflow.summarize(state, signal)
      state.pending = undefined
    }
    return { kind: 'retry' }
  }, { prepend: true })
  return () => workflow.busy()
}
