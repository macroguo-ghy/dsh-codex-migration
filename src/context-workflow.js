import { resumeIdPrefix, resumeInstruction } from './resume-notice.js'
import { randomUUID } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'

export const CHOICE = 'plugin:codex-migration/context-choice'

export function currentChoice(session) {
  return session.snapshotEvents().findLast(event => event.type === CHOICE)?.data
}

export function writeChoice(session, choice, changes) {
  const next = { ...choice, ...changes, revision: (choice.revision ?? 0) + 1, update: true }
  appendPluginRecord(session, CHOICE, next)
  return next
}

function preciseSources(sources) {
  return '\n精确来源（原消息 UTF-16 字符偏移，from 包含、to 不含）：\n'
    + sources.map(source => 'seq=' + source.seq + ' from=' + source.from + ' to=' + source.to).join('\n')
}

function continuePending(agent) {
  agent.followup({ id: resumeIdPrefix + randomUUID(), role: 'user', source: { kind: 'codex-imported-context', form: 'notice' },
    content: [{ type: 'text', text: resumeInstruction }] })
}

export function installContextWorkflow(ctx, stateFor) {
  const jobs = new Map()
  ctx.effect(() => () => {
    for (const job of jobs.values()) job.abort.abort(new Error('插件停用，摘要进度已保留'))
    return Promise.allSettled([...jobs.values()].map(job => job.promise))
  })
  function offer(state, envelope, reason) {
    const { session, checkpoint } = state
    const events = session.snapshotEvents()
    const pending = events.findLast(event => event.seq > checkpoint && event.type === 'user/message'
      && ['user', 'user-rpc'].includes(event.data.source.kind))
      ?? events.findLast(event => event.seq > checkpoint && event.type === 'user/message'
        && !['runtime-context', 'codex-imported-context'].includes(event.data.source.kind))
    const previous = currentChoice(session)
    const reuse = previous?.status === 'pending' && previous.pendingSeq === pending?.seq
    const omitted = events.filter(event => event.type === 'plugin:codex-migration/request-budget')
      .reduce((count, event) => count + event.data.omitted.length, 0)
    const choice = { ...(reuse ? previous : { id: randomUUID(), update: false }), status: 'pending',
      ...envelope, estimated: Math.ceil(ctx.tokenMeter.measure(session).totalTokens * 1.15),
      omitted, pendingSeq: pending?.seq ?? null, reason,
      preview: pending?.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 500) ?? '' }
    appendPluginRecord(session, CHOICE, { ...choice, update: !!reuse })
  }
  ctx.commands.register({
    definitionId: 'dsh-codex-migration/context', name: 'codex-context',
    description: '选择迁移会话的续聊方式、恢复摘要或取消',
    input: { hint: '[models | model | summarize | cancel] [选择ID] [模型序号]' },
    async handler({ agent, rawInput, signal }) {
      const [action = 'status', id, index] = rawInput.trim().split(/\s+/)
      let choice = currentChoice(agent.session)
      const error = text => ({ kind: 'error', text })
      if (!choice) return error('当前会话没有待处理的迁移上下文选择。')
      if (action === 'status') return { kind: 'success', text: '迁移续聊状态：' + choice.status + ' · ' + choice.id }
      if (id !== choice.id) return error('此选择已过期，请使用最新的续聊选择卡片。')
      if (action === 'summaries') {
        const events = agent.session.snapshotEvents()
        const adopted = events.findLast(event => event.type === 'plugin:codex-migration/summary-commit'
          && events.some(end => end.type === 'plugin:codex-migration/summary-committed' && end.data.id === event.data.id))
        if (adopted) {
          const blocks = events.filter(event => event.type === 'plugin:codex-migration/summary-block'
            && adopted.data.resultIds?.includes(event.data.id))
          return { kind: 'success', text: adopted.data.text + (blocks.length
            ? preciseSources(blocks.flatMap(block => block.data.sources)) : '') }
        }
        const native = events.findLast(event => event.type === 'compaction/summary')
        if (native) return { kind: 'success', text: 'DSH 原生摘要 · 来源 seq ' + native.data.shadowedSeqs.join(', ')
          + '\n' + native.data.summary.map(block => block.text).join('\n') }
        const blocks = events.filter(event => event.type === 'plugin:codex-migration/summary-block')
        return { kind: 'success', text: blocks.length ? blocks.map(event => '已保存的阶段摘要（尚未全部采用） · ' + event.data.phase
          + '\n' + event.data.text + preciseSources(event.data.sources)).join('\n\n') : '尚无已保存的摘要。' }
      }
      if (action === 'cancel' && choice.status === 'summarizing') {
        jobs.get(agent.session.id)?.abort.abort(new Error('用户取消摘要'))
        agent.cancel({ kind: 'hook', reason: '用户取消摘要准备' }, { keepInbox: true })
        writeChoice(agent.session, choice, { status: 'cancelled', reason: '已取消，原始输入和已完成摘要进度均保留。' })
        return { kind: 'success', text: '已取消摘要，输入已保留。' }
      }
      if (!['pending', 'error'].includes(choice.status) || jobs.has(agent.session.id)) return error('此选择已完成、已取消或正在处理，请使用最新卡片。')
      if (['model', 'summarize'].includes(action)) {
        await agent.whenIdle()
        signal.throwIfAborted()
        const latest = currentChoice(agent.session)
        if (latest?.id !== choice.id || !['pending', 'error'].includes(latest.status)) return error('此选择已过期或正在处理，请使用最新卡片。')
        choice = latest
      }
      const state = stateFor(agent)
      const stillCurrent = () => {
        signal.throwIfAborted()
        const latest = currentChoice(agent.session)
        return latest?.id === choice.id && latest.status === choice.status
          && (latest.revision ?? 0) === (choice.revision ?? 0)
      }
      if (state.ready) return error('该会话已经完成首次续聊，无需再次准备上下文。')
      if (action === 'cancel') {
        writeChoice(agent.session, choice, { status: 'cancelled', reason: '已取消，待续聊输入仍完整保存在本会话中。' })
        return { kind: 'success', text: '已取消；输入已保留，可从卡片恢复草稿。' }
      }
      if (action === 'models') {
        const catalog = await ctx.get('sessionController').modelCatalog()
        const models = [], failures = []
        for (const group of catalog.groups) for (const item of group.models) {
          signal.throwIfAborted()
          try {
            const info = await ctx.llm.resolveModelInfo(group.id, item.id, signal)
            if (info.context?.contextWindow > choice.window) models.push({ provider: group.id, model: item.id,
              name: item.name, window: info.context.contextWindow })
          } catch { failures.push(group.id + '/' + item.id) }
        }
        if (!stillCurrent()) return error('此选择已变化，请使用最新卡片。')
        choice = writeChoice(agent.session, choice, { models: models.sort((a, b) => a.window - b.window),
          modelWarnings: failures.length + catalog.failures.length,
          reason: models.length ? '请选择更大窗口模型，选择后会重新检查预算。' : '没有已确认可用的更大窗口模型；可选择摘要后续聊。' })
        return { kind: 'success', text: choice.reason }
      }
      if (action === 'model') {
        const selected = choice.models?.[Number(index)]
        if (!selected || !/^\d+$/.test(index ?? '')) return error('请选择卡片列出的模型。')
        const info = await ctx.llm.resolveModelInfo(selected.provider, selected.model, signal)
        if (!stillCurrent()) return error('此选择已变化，请使用最新卡片。')
        if (!(info.context?.contextWindow > choice.window)) return error('该模型当前没有更大的生效窗口，请刷新模型列表。')
        agent.model.select({ provider: selected.provider, model: selected.model })
        writeChoice(agent.session, choice, { status: 'resuming', reason: '已切换模型，正在重新检查续聊预算。' })
        continuePending(agent)
        return { kind: 'success', text: '已切换模型并恢复续聊。' }
      }
      if (action !== 'summarize') return error('用法：/codex-context [models | model | summarize | cancel] 选择ID [模型序号]')
      writeChoice(agent.session, choice, { status: 'summarizing', reason: '正在准备摘要，完整原始历史保留。' })
      continuePending(agent)
      return { kind: 'success', text: '已开始摘要准备，完成后自动续聊；可以在卡片中取消。' }
    },
  })
  async function summarize(state, signal) {
      const { agent, session } = state
      const abort = new AbortController(), operationSignal = AbortSignal.any([signal, abort.signal])
      const job = { abort, promise: undefined }
      jobs.set(session.id, job)
      job.promise = (async () => {
        try {
          const { summarizeContext } = await import('./context-summary.js')
          await summarizeContext(ctx, state, operationSignal)
          operationSignal.throwIfAborted()
          writeChoice(agent.session, currentChoice(agent.session), { status: 'resuming', reason: '摘要准备完成，正在检查并恢复续聊。' })
        } catch (cause) {
          const reason = cause.message ?? String(cause)
          writeChoice(agent.session, currentChoice(agent.session), { status: operationSignal.aborted ? 'cancelled' : 'error', reason })
          throw new Error(reason + '；原始输入和已完成摘要进度均已保留。', { cause })
        } finally { jobs.delete(agent.session.id) }
      })()
      return job.promise
  }
  return { offer, summarize, busy: () => jobs.size > 0 }
}
