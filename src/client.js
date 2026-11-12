import { createElement as h, useState } from 'react'
import { DisclosureRow, Button, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

export const inject = ['slots', 'uiConversation', 'remote', 'remote.session', 'remote.commands']

const kind = 'codex-migration-budget'
const reportKind = 'codex-migration-report'
const choiceKind = 'codex-migration-context-choice'

function definition(kind, type) { return {
  kind,
  target: 'chat',
  match: event => event.type === type
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => match.event.data,
  update: context => context.state,
  buildViewNode(context) {
    const start = context.start ?? context.matches[0]
    if (!start) return null
    return {
      key: context.key, kind, id: context.id, target: 'chat', anchorSeq: start.event.seq,
      location: start.location, visibility: 'visible', groupTree: 'turn', data: context.state ?? start.event.data,
    }
  },
} }

export const budgetDefinition = definition(kind, 'plugin:codex-migration/request-budget')
export const reportDefinition = definition(reportKind, 'plugin:codex-migration/report')
export const choiceDefinition = {
  ...definition(choiceKind, 'plugin:codex-migration/context-choice'),
  match: event => event.type === 'plugin:codex-migration/context-choice' ? { id: event.data.id, role: 'start' } : null,
  update: (_context, match) => match.event.data,
}

const reasoningKind = 'codex-migration-reasoning-summary'
const reasoningBase = definition(reasoningKind, 'assistant/message')
function reasoningState(event, previous) {
  const texts = event.data.message.content.filter(block => block.type === 'reasoning' && block.text?.trim()).map(block => block.text)
  return { lastSeq: event.seq, items: [...(previous?.items ?? []), ...(texts.length ? [{ seq: event.seq, texts }] : [])] }
}
export const reasoningDefinition = {
  ...reasoningBase,
  match(event) {
    const data = event.data, message = data?.message
    return event.type === 'assistant/message' && message?.source?.provider === 'codex' && message.id?.startsWith('codex-message-')
      ? { id: data.turn + ':' + data.step, role: 'start' } : null
  },
  start: (_context, match) => reasoningState(match.event),
  update: (context, match) => reasoningState(match.event, context.state),
  buildViewNode(context) {
    const state = context.state
    const hidden = state?.items.filter(item => item.seq !== state.lastSeq) ?? []
    if (!hidden.length) return null
    const node = reasoningBase.buildViewNode(context)
    return node && { ...node, anchorSeq: hidden[0].seq, data: { items: hidden } }
  },
}
function ReasoningCard({ node }) {
  const [open, setOpen] = useState(false)
  return h('div', { className: 'dsh-codex-budget' }, h('style', null, styles),
    h(DisclosureRow, { icon: h(IconContextInjectionOutlineRegular, { size: 14 }), title: 'Codex 历史推理摘要',
      open, expandable: true, expandOnRowClick: true, onToggle: () => setOpen(!open),
      collapsedContent: h('span', { className: 'dsh-codex-budget-summary' }, '可读摘要 ' + node.data.items.length + ' 条'),
    }, h('div', { className: 'dsh-codex-budget-body' },
      h('p', { className: 'dsh-codex-budget-note' }, 'Codex 保存的可读摘要，不是完整隐藏推理。此处展示不新增模型输入。'),
      node.data.items.map(item => h('div', { key: item.seq }, h('p', { className: 'dsh-codex-budget-note' }, '原事件 ' + item.seq),
        h('pre', { className: 'dsh-codex-context-summary' }, item.texts.join('\n')))))))
}

function ChoiceCard({ node, act, restore, inputActions, readSource }) {
  const data = node.data
  const [open, setOpen] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [details, setDetails] = useState(''), [model, setModel] = useState('0')
  const active = ['pending', 'error'].includes(data.status)
  const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知'
  async function run(action) {
    setBusy(true); setError('')
    try {
      const result = await act(action, data.id)
      if (action === 'summaries') setDetails(result.text)
      if (action === 'cancel' && inputActions && data.pendingSeq !== null) {
        const text = await restore(data.pendingSeq)
        const span = inputActions.captureInsertion()
        if (!inputActions.insertText(text, { ...span, start: span.end })) throw new Error('输入正在编辑或发送，文字仍保留在原消息中，可稍后恢复。')
        inputActions.persistDraft()
      }
    } catch (cause) { setError(cause.message ?? String(cause)) }
    finally { setBusy(false) }
  }
  return h('div', { className: 'dsh-codex-budget' }, h('style', null, styles),
    h(DisclosureRow, { icon: h(IconContextInjectionOutlineRegular, { size: 14 }), title: data.status === 'ready' ? '迁移续聊已恢复 · 准备阶段超限已解决' : '迁移续聊上下文',
      open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true, onToggle: () => setOpen(value => !value),
      collapsedContent: h('span', { className: 'dsh-codex-budget-summary' },
        data.status === 'ready' ? '已恢复续聊' : data.status === 'cancelled' ? '已取消，输入保留' : data.status === 'summarizing' ? '摘要准备中' : '需要选择续聊方式'),
    }, h('div', { className: 'dsh-codex-budget-body' },
      h('p', { className: 'dsh-codex-budget-note' }, data.reason),
      h('dl', { className: 'dsh-codex-budget-metrics' },
        [['生效窗口', number(data.window)], ['输入估算 / 预算', number(data.estimated) + ' / ' + number(data.budget)],
          ['已省略旧工具', number(data.omitted) + ' 对']].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
      active && h('p', { className: 'dsh-codex-budget-note' }, '切换模型可保留更多原文。摘要会优先保留全部真人输入；仍放不下时摘要较早输入，近期输入保留原文。完整原记录始终保留。'),
      active && h('div', { className: 'dsh-codex-context-actions' },
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => run('models') }, '切换更大窗口模型'),
        h(Button, { variant: 'secondary', size: 'sm', disabled: busy, onClick: () => run('summarize') }, data.status === 'error' ? '继续摘要并续聊' : '摘要后续聊')),
      active && data.models && h('div', { className: 'dsh-codex-context-actions' },
        data.models.length ? h('select', { 'aria-label': '更大窗口模型', value: model, onChange: event => setModel(event.target.value), disabled: busy },
          data.models.map((item, index) => h('option', { key: index, value: String(index) }, item.name + ' · ' + item.provider + ' · ' + number(item.window))))
          : h('span', null, '没有已确认可用的更大窗口模型。'),
        data.models.length > 0 && h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => run('model ' + model) }, '切换并续聊')),
      data.modelWarnings > 0 && h('p', { className: 'dsh-codex-budget-note' }, '部分模型信息读取失败，可稍后刷新列表。'),
      h('div', { className: 'dsh-codex-context-actions' },
        (active || data.status === 'summarizing') && h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => run('cancel') }, '取消'),
        h(Button, { variant: 'ghost', size: 'sm', disabled: busy, onClick: () => run('summaries') }, '查看摘要与来源')),
      data.preview && h('details', null, h('summary', null, '已保留的待续聊输入'), h('p', { className: 'dsh-codex-budget-note' }, data.preview)),
      details && h(SummaryDetails, { text: details, readSource }),
      error && h('p', { role: 'alert' }, error))))
}

function SummaryDetails({ text, readSource }) {
  const [limit, setLimit] = useState(20), [original, setOriginal] = useState(null)
  const lines = text.split('\n'), sources = lines.filter(line => /^seq=\d+ from=\d+ to=\d+$/.test(line))
  const body = lines.filter(line => !/^seq=\d+ from=\d+ to=\d+$/.test(line) && !line.startsWith('精确来源（')).join('\n')
  async function open(line, index) {
    const seq = Number(line.match(/^seq=(\d+)/)[1])
    setOriginal({ index, text: '读取中…' })
    try { const text = await readSource(seq); setOriginal(current => current?.index === index ? { index, text } : current) }
    catch (error) { setOriginal(current => current?.index === index ? { index, text: error.message } : current) }
  }
  return h('section', { 'aria-label': '摘要及来源' },
    h('pre', { className: 'dsh-codex-context-summary' }, body),
    sources.length > 0 && h('details', null, h('summary', null, '原记录来源 · ' + sources.length + ' 段（展开查看）'),
      h('p', { className: 'dsh-codex-budget-note' }, '逐条查看对应轮次和原消息。精确偏移为 UTF-16 字符位置，不代表轮次。'),
      sources.slice(0, limit).map((line, index) => h('div', { key: index, className: 'dsh-codex-budget-record' },
        h('code', null, line), h(Button, { size: 'sm', variant: 'ghost', onClick: () => open(line, index) }, '查看原消息'),
        original?.index === index && h('pre', { className: 'dsh-codex-context-summary', 'aria-label': '摘要对应的原消息', role: 'status' }, original.text))),
      sources.length > limit && h(Button, { size: 'sm', variant: 'ghost', onClick: () => setLimit(limit + 30) }, '显示更多来源')))
}

function BudgetCard({ node, readOriginal }) {
  const [open, setOpen] = useState(false)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [limit, setLimit] = useState(30)
  const [original, setOriginal] = useState(null)
  const data = node.data
  const omitted = data.omitted ?? []
  const counts = new Map()
  for (const pair of omitted) counts.set(pair.name, (counts.get(pair.name) ?? 0) + 1)
  const number = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未记录'
  const retained = Number.isFinite(data.retainedPairs) ? '保留 ' + number(data.retainedPairs) + ' 对' : '保留数量未记录'
  const time = value => new Date(value).toLocaleString('zh-CN', { hour12: false })
  async function openOriginal(pair) {
    setOriginal({ pair, loading: true })
    try {
      const text = await readOriginal(pair, node.data.address)
      setOriginal(current => current?.pair === pair ? { pair, text } : current)
    } catch (error) {
      setOriginal(current => current?.pair === pair ? { pair, error: error.message ?? String(error) } : current)
    }
  }
  return h('div', { className: 'dsh-codex-budget' },
    h('style', null, styles),
    h(DisclosureRow, {
      icon: h(IconContextInjectionOutlineRegular, { size: 14 }),
      title: data.phase === 'initial' ? '首次续聊准备' : '迁移续聊', open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value),
      collapsedContent: h('span', { className: 'dsh-codex-budget-summary' },
        '已省略 ' + number(omitted.length) + ' 对工具轨迹'),
    }, h('div', { className: 'dsh-codex-budget-body' },
      h('p', { className: 'dsh-codex-budget-note' },
        '真人输入和历史模型正文全部保留。工具记录来自旧 Codex 环境，当前工具能力以本轮提供的定义为准。'),
      data.phase === 'initial' && h('p', { className: 'dsh-codex-budget-note' },
        '此步骤仅省略工具轨迹；摘要需要在续聊选择中明确选择。完整原记录仍可查看，首次续聊成功后使用 DSH 原生自动压缩。'),
      h('dl', { className: 'dsh-codex-budget-metrics' },
        [
          ['生效窗口', number(data.window) + ' token'],
          ['输入估算 / 预算', number(data.estimated) + ' / ' + number(data.budget)],
          ['输出预留', number(data.outputReserve) + ' token'],
          ...(data.phase === 'initial' ? [['首次上下文上界', number(data.threshold) + ' token']] : []),
          ['估算余量', number(data.margin) + ' token'],
          ['工具轨迹', '省略 ' + number(omitted.length) + ' 对 · ' + retained],
        ].map(([label, value]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value)))),
      data.timeRange && h('p', { className: 'dsh-codex-budget-note' },
        '省略范围：' + time(data.timeRange.start) + ' — ' + time(data.timeRange.end)),
      counts.size > 0 && h('div', { className: 'dsh-codex-budget-tools' },
        [...counts].sort((a, b) => b[1] - a[1]).map(([name, count]) =>
          h('span', { key: name }, h('code', null, name), h('span', null, number(count) + ' 对')))),
      omitted.length > 0 && h(DisclosureRow, {
        icon: h(IconContextInjectionOutlineRegular, { size: 14 }),
        title: '查看省略的原工具记录', open: recordsOpen, expandable: true, expandOnRowClick: true,
        onToggle: () => setRecordsOpen(value => !value),
      }, h('div', { className: 'dsh-codex-budget-records' },
        h('div', { className: 'dsh-codex-budget-list' }, omitted.slice(0, limit).map((pair, index) =>
          h('div', { key: index, className: 'dsh-codex-budget-record' },
            h('code', null, pair.name),
            h('span', { className: 'dsh-codex-budget-seq' }, 'seq ' + pair.assistantSeq + '–' + pair.resultSeq),
            h(Button, { type: 'button', variant: 'ghost', size: 'sm', onClick: () => openOriginal(pair),
              'aria-label': '查看原记录 ' + pair.assistantSeq + '–' + pair.resultSeq }, '查看原记录')))),
        limit < omitted.length && h(Button, {
          type: 'button', variant: 'ghost', size: 'sm', onClick: () => setLimit(value => value + 30),
        }, '显示更多（' + number(Math.min(limit, omitted.length)) + ' / ' + number(omitted.length) + '）'),
        original && h('section', { 'aria-label': '省略工具的完整原记录', className: 'dsh-codex-budget-original' },
          h('div', { className: 'dsh-codex-budget-note' },
            original.pair.name + ' · seq ' + original.pair.assistantSeq + '–' + original.pair.resultSeq),
          original.loading ? h('p', null, '正在读取原记录…')
            : h('pre', { role: original.error ? 'alert' : undefined }, original.error ?? original.text)))))))

}

export function apply(ctx) {
  ctx.effect(() => ctx.uiConversation.events.register(budgetDefinition))
  ctx.effect(() => ctx.uiConversation.events.register(reportDefinition))
  ctx.effect(() => ctx.uiConversation.events.register(choiceDefinition))
  ctx.effect(() => ctx.uiConversation.events.register(reasoningDefinition))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: reasoningKind }, ReasoningCard))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: choiceKind,
    inject: sessionId => ({
      async act(action, id) {
        const [verb, index] = action.split(' ')
        const response = await ctx.remote.commands.execute(sessionId, '/codex-context ' + verb + ' ' + id + (index ? ' ' + index : ''), [])
        if (!response.ok) throw new Error(response.error.message)
        const result = response.value?.result
        if (!result || result.kind === 'error') throw new Error(result?.text ?? '无法执行上下文选择。')
        return result
      },
      async readSource(seq) {
        const response = await ctx.remote.session.page({ address: { kind: 'session', sessionId }, throughSeq: seq, beforeSeq: seq + 1, maxMessages: 1 }, AbortSignal.timeout(15000))
        if (!response.ok) throw new Error(response.error.message)
        const event = response.value.records.find(record => record.event.seq === seq)?.event
        if (!event) throw new Error('原记录暂时不可读取，请稍后重试。')
        const data = event.data, message = data.message ?? data
        const title = (data.turn ? '第 ' + data.turn + ' 轮 · ' : '') + '原事件 ' + seq + ' · ' + (message.role ?? event.type)
        const content = message.content?.map(block => ['text', 'reasoning'].includes(block.type) ? block.text : JSON.stringify(block)).join('\n')
        return title + '\n\n' + (content ?? JSON.stringify(event, null, 2))
      },
      async restore(seq) {
        const response = await ctx.remote.session.page({ address: { kind: 'session', sessionId }, throughSeq: seq, beforeSeq: seq + 1, maxMessages: 1 }, AbortSignal.timeout(15000))
        if (!response.ok) throw new Error(response.error.message)
        const message = response.value.records.find(record => record.event.seq === seq && record.event.type === 'user/message')?.event.data
        if (!message) throw new Error('暂时无法读取原输入，原记录仍保留。')
        return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      },
    }),
  }, ChoiceCard))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: kind,
    inject: sessionId => ({
      async readOriginal(pair, address) {
        const results = await Promise.all([pair.assistantSeq, pair.resultSeq].map(seq => ctx.remote.session.page({
          address: address ?? { kind: 'session', sessionId }, throughSeq: seq,
          beforeSeq: seq + 1, maxMessages: 1,
        }, AbortSignal.timeout(15000))))
        for (const result of results) if (!result.ok) throw new Error(result.error.message)
        const records = new Map(results.flatMap(result => result.value.records.map(record => [record.event.seq, record.event])))
        if (!records.has(pair.assistantSeq) || !records.has(pair.resultSeq)) throw new Error('原记录不完整，无法显示对应调用和结果')
        return JSON.stringify([records.get(pair.assistantSeq), records.get(pair.resultSeq)], null, 2)
      },
    }),
  }, BudgetCard))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: reportKind,
  }, ReportCard))
}


function MemberDetails({ member }) {
  const [limit, setLimit] = useState(30)
  const analysis = member.analysis
  return h('div', { className: 'dsh-codex-budget-body' },
    h('p', { className: 'dsh-codex-budget-note' }, member.status + ' · ' + member.source + ' → ' + member.id),
    member.reason && h('p', null, member.reason),
    analysis?.summary?.length > 0 && h('div', { className: 'dsh-codex-budget-tools' },
      analysis.summary.map(item => h('span', { key: item.category }, item.label + ' ' + item.count + ' ' + item.unit))),
    (member.dependencies ?? []).map(dep => h('p', { key: dep.name, className: 'dsh-codex-budget-note' },
      '外部依赖 ' + dep.name + ' · ' + dep.status + ' · ' + dep.count + ' 条 · ' + dep.evidence)),
    member.dependencies?.length > 0 && h('p', { className: 'dsh-codex-budget-note' }, '静态配置不代表连接可用，未进行连接探测。'),
    analysis?.items?.length > 0 && h('ol', { className: 'dsh-codex-report-items' },
      analysis.items.slice(0, limit).map((item, index) => h('li', { key: index },
        h('span', null, item.message),
        h('div', { className: 'dsh-codex-budget-note' }, item.source + ' · 源行 ' + (item.line ?? '未记录')
          + (item.block === undefined ? '' : ' · 块 ' + (item.block + 1)))))),
    analysis?.items?.length > limit && h(Button, { type: 'button', variant: 'ghost', size: 'sm',
      onClick: () => setLimit(value => value + 30) }, '显示更多差异（' + limit + ' / ' + analysis.items.length + '）'))
}

function MemberRow({ member }) {
  const [open, setOpen] = useState(false)
  return h(DisclosureRow, { icon: h(IconContextInjectionOutlineRegular, { size: 14 }),
    title: member.title || member.source, open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
    onToggle: () => setOpen(value => !value), collapsedContent: h('span', { className: 'dsh-codex-budget-summary' }, '子 agent · ' + member.status),
  }, h(MemberDetails, { member }))
}

export function GroupRow({ group }) {
  const [open, setOpen] = useState(false)
  const root = group.results.find(member => member.source === group.root)
  return h(DisclosureRow, { icon: h(IconContextInjectionOutlineRegular, { size: 14 }),
    title: root?.title || group.root, open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
    onToggle: () => setOpen(value => !value), collapsedContent: h('span', { className: 'dsh-codex-budget-summary' }, group.status),
  }, h('div', { className: 'dsh-codex-budget-body' },
    group.reason && h('p', null, group.reason), root && h(MemberDetails, { member: root }),
    group.results.filter(member => member !== root).map(member => h(MemberRow, { key: member.source, member })),
    group.failures.map(failure => h('p', { key: failure.id, className: 'dsh-codex-budget-note' },
      failure.id + ' · ' + (failure.phase ?? '历史未迁入') + '：' + failure.reason))))
}

function ReportCard({ node }) {
  const [open, setOpen] = useState(false)
  const data = node.data
  return h('div', { className: 'dsh-codex-budget' }, h('style', null, styles),
    h(DisclosureRow, { icon: h(IconContextInjectionOutlineRegular, { size: 14 }), title: data.title,
      open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value),
      collapsedContent: h('span', { className: 'dsh-codex-budget-summary' }, data.summary),
    }, h('div', { className: 'dsh-codex-budget-body' },
      data.groups.map(group => h(GroupRow, { key: group.root, group })),
      data.issues.map((issue, index) => h('p', { key: index, className: 'dsh-codex-budget-note' }, issue.id + '：' + issue.reason)))))
}
