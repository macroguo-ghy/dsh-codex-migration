import { createElement as h, useState } from 'react'
import { DisclosureRow, Button, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

export const inject = ['slots', 'uiConversation', 'remote', 'remote.session']

const kind = 'codex-migration-budget'
const reportKind = 'codex-migration-report'

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
        '首次准备不生成摘要，完整原记录仍可查看。准备成功后的新增对话使用 DSH 原生自动压缩。'),
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

function GroupRow({ group }) {
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
