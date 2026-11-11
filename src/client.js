import { createElement as h, useState } from 'react'
import { DisclosureRow, Button, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

export const inject = ['slots', 'uiConversation', 'remote', 'remote.session']

const kind = 'codex-migration-budget'

export const budgetDefinition = {
  kind,
  target: 'chat',
  match: event => event.type === 'plugin:codex-migration/request-budget'
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
      const text = await readOriginal(pair)
      setOriginal(current => current?.pair === pair ? { pair, text } : current)
    } catch (error) {
      setOriginal(current => current?.pair === pair ? { pair, error: error.message ?? String(error) } : current)
    }
  }
  return h('div', { className: 'dsh-codex-budget' },
    h('style', null, styles),
    h(DisclosureRow, {
      icon: h(IconContextInjectionOutlineRegular, { size: 14 }),
      title: '迁移续聊', open, expandable: true, expandOnRowClick: true, keepContentWhenOpen: true,
      onToggle: () => setOpen(value => !value),
      collapsedContent: h('span', { className: 'dsh-codex-budget-summary' },
        '已省略 ' + number(omitted.length) + ' 对工具轨迹'),
    }, h('div', { className: 'dsh-codex-budget-body' },
      h('p', { className: 'dsh-codex-budget-note' },
        '真人输入和历史模型正文全部保留。工具记录来自旧 Codex 环境，当前工具能力以本轮提供的定义为准。'),
      h('dl', { className: 'dsh-codex-budget-metrics' },
        [
          ['生效窗口', number(data.window) + ' token'],
          ['输入估算 / 预算', number(data.estimated) + ' / ' + number(data.budget)],
          ['输出预留', number(data.outputReserve) + ' token'],
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
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: kind,
    inject: sessionId => ({
      async readOriginal(pair) {
        const result = await ctx.remote.session.page({
          address: { kind: 'session', sessionId }, throughSeq: pair.resultSeq,
          beforeSeq: pair.resultSeq + 1, maxMessages: 3,
        }, AbortSignal.timeout(15000))
        if (!result.ok) throw new Error(result.error.message)
        const records = result.value.records.map(record => record.event)
          .filter(event => event.seq === pair.assistantSeq || event.seq === pair.resultSeq)
        if (records.length !== 2) throw new Error('原记录不完整，无法显示对应调用和结果')
        return JSON.stringify(records, null, 2)
      },
    }),
  }, BudgetCard))
}
