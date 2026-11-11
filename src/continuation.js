import { digest } from './source.js'
const SESSION_ID = /^session-codex-[a-f0-9]{64}$/
export const MAX_DEFAULT_OUTPUT = 32768

export function importedSession(session) {
  return SESSION_ID.test(session.id) && session.eventAt(0)?.type === 'codex-migration/begin'
}

function importedPairs(messages) {
  const open = new Map()
  const pairs = []
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const [blockIndex, block] of message.content.entries()) {
        if (block.type !== 'tool-call') continue
        open.set(block.id, message.id?.startsWith('codex-message-')
          ? { index, blockIndex, name: block.name } : null)
      }
    }
    if (message.role === 'tool') {
      const call = open.get(message.toolCallId)
      open.delete(message.toolCallId)
      if (call && message.id?.startsWith('codex-result-')) pairs.push({ ...call, result: index })
    }
  }
  return pairs.sort((a, b) => a.index - b.index || a.blockIndex - b.blockIndex)
}

function historyNotice(sessionId, pairs, total, seqs, names) {
  const counts = new Map()
  let first = Infinity
  let last = 0
  for (const pair of pairs) {
    counts.set(pair.name, (counts.get(pair.name) ?? 0) + 1)
    first = Math.min(first, seqs[pair.index] ?? first)
    last = Math.max(last, seqs[pair.result] ?? last)
  }
  const details = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([name, count]) => name + ' ×' + count).join('、')
  const range = Number.isFinite(first) ? '，涉及原 DSH 日志 seq ' + first + '–' + last : ''
  const provenance = 'Codex 历史结束，以下为 DSH 中新增的对话。Codex 历史工具说明：以上导入的工具记录来自旧 Codex 运行环境，工具名称包括 '
    + names.join('、') + '。这些调用及结果描述历史执行情况。当前可用工具和参数以本次请求提供的工具定义为准，'
    + '即使名称相同，也不能据旧调用推断当前工具的能力、权限、工作目录或执行状态。'
  const omission = pairs.length ? '迁移续聊提示：为适应模型窗口，本次省略了 ' + pairs.length
    + ' 对旧工具调用及对应结果，保留了 ' + (total - pairs.length) + ' 对可配对的导入工具轨迹。'
    + '省略的主要工具：' + details + range + '。完整记录仍在 DSH 会话 ' + sessionId
    + '。如果判断依赖省略的结果，请查阅原记录或向用户索取对应证据，不要猜测。' : ''
  return {
    id: 'codex-migration-omitted-tools',
    role: 'user',
    source: { kind: 'codex-imported-context', form: 'notice' },
    content: [{ type: 'text', text: [provenance, omission].filter(Boolean).join('\n\n') }],
  }
}

function calibration(session, route) {
  let audit, factor = 1.15
  for (let seq = 0; seq < (session.seq ?? 0); seq++) {
    const event = session.eventAt(seq)
    if (event.type === 'plugin:codex-migration/request-budget') audit = event.data
    if (event.type !== 'assistant/message' || event.data.interrupted || audit?.route !== route) continue
    const usage = event.data.usage
    const input = usage && usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (Number.isFinite(input) && input > 0 && audit.rawEstimate > 0) {
      factor = Math.max(factor, input / audit.rawEstimate * 1.02)
    }
    audit = undefined
  }
  return factor
}

/** Only the outgoing model surface is changed. Every durable message stays intact. */
export function fitImportedRequest(meter, session, request, window, record, { forceAll = false, configuration = null } = {}) {
  if (!Number.isSafeInteger(window) || window <= 0) {
    throw new Error('当前模型没有生效上下文窗口，请配置模型窗口或切换到已知窗口的模型。')
  }
  const header = session.requestHeader()
  const measure = meter.measure(session, header)
  const reserve = request.maxTokens ?? MAX_DEFAULT_OUTPUT
  // The multiplier corrects heuristic pricing; retain a small additional
  // allowance without charging the same estimation uncertainty twice.
  const margin = Math.min(2048, Math.ceil(window * 0.01))
  const budget = window - reserve - margin
  const route = digest(JSON.stringify({ configuration: configuration ?? {
    provider: request.provider ?? null, model: request.model ?? null,
    reasoningEffort: request.reasoningEffort ?? null, maxTokens: reserve,
  }, window, tools: request.tools ?? [] }))
  const factor = calibration(session, route)
  const toolSchema = request.tools?.length ? Math.ceil(JSON.stringify(request.tools).length / 4) + 4 : 0
  let raw = measure.surfaceTokens + toolSchema
  const pairs = importedPairs(request.messages)
  const names = [...new Set(pairs.map(pair => pair.name))]
  const prices = new Map()
  for (const node of measure.nodes) {
    const event = session.eventAt(node.seq)
    const message = event && session.deriveEventMessage(event)
    if (message) prices.set(message.id, node)
  }
  const seqs = request.messages.map(message => prices.get(message.id)?.seq)
  const omissions = [], changed = new Map(), deleted = new Set()
  let notice = historyNotice(session.id, omissions, pairs.length, seqs, names)
  const estimate = () => Math.ceil((raw + meter.estimateMessage(notice)) * factor)
  for (const pair of pairs) {
    if (!forceAll && estimate() <= budget) break
    const original = request.messages[pair.index]
    const current = changed.get(pair.index) ?? original
    const result = request.messages[pair.result]
    const reduced = { ...original, content: current.content.filter(block => block !== original.content[pair.blockIndex]) }
    changed.set(pair.index, reduced)
    if (!reduced.content.length) deleted.add(pair.index)
    deleted.add(pair.result)
    raw -= meter.estimateMessage(current) - (reduced.content.length ? meter.estimateMessage(reduced) : 0)
    raw -= prices.get(result.id)?.tokens ?? meter.estimateMessage(result)
    omissions.push(pair)
    notice = historyNotice(session.id, omissions, pairs.length, seqs, names)
  }
  const estimated = estimate()
  if (estimated > budget) {
    throw new Error('保留原文后的续聊请求约需 ' + estimated + ' 个输入 token，当前模型预算为 '
      + Math.max(budget, 0) + '。请切换到上下文窗口更大的模型。')
  }
  const messages = request.messages.flatMap((message, index) => deleted.has(index) ? [] : [changed.get(index) ?? message])
  const importedEnd = messages.findLastIndex(message => /^codex-(?:message|user|context|result|system)-/.test(message.id ?? ''))
  messages.splice(importedEnd + 1, 0, notice)
  const omittedTimes = omissions.flatMap(pair => [pair.index, pair.result])
    .map(index => seqs[index] === undefined ? null : session.eventAt(seqs[index])?.time).filter(Number.isFinite)
  const timeRange = omittedTimes.length ? { start: Math.min(...omittedTimes), end: Math.max(...omittedTimes) } : null
  const address = session.header?.origin === 'subagent'
    ? { kind: 'subagent', parentSessionId: session.header.parentSession, childSessionId: session.id, mode: 'continuable' }
    : { kind: 'session', sessionId: session.id }
  record({ window, budget, estimated, rawEstimate: raw + meter.estimateMessage(notice), factor, route, address,
    outputReserve: reserve, margin, totalPairs: pairs.length, retainedPairs: pairs.length - omissions.length,
    retry: forceAll, timeRange, omitted: omissions.map(pair => ({
      name: pair.name, callId: request.messages[pair.index].content[pair.blockIndex].id,
      assistantSeq: seqs[pair.index] ?? null, resultSeq: seqs[pair.result] ?? null,
    })) })
  return { ...request, messages }
}
