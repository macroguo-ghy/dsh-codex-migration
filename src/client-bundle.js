window.__ModuleLoader__.load({
  id: "dsh-codex-migration",
  factory: require => {
    const { createElement: h, useState } = require('react')
    const { DisclosureRow, Button, IconContextInjectionOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const styles = ".dsh-codex-budget {\n  min-width: 0;\n  color: var(--dsw-alias-label-secondary);\n  font-size: var(--dsh-content-font-size-secondary, 13px);\n  line-height: 1.6;\n}\n\n.dsh-codex-budget-summary {\n  margin-left: 8px;\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dsh-codex-budget-body {\n  margin: 4px 0 8px 22px;\n  padding: 4px 0 4px 16px;\n  border-left: 1px solid var(--dsw-alias-border-l1);\n}\n\n.dsh-codex-budget-note {\n  margin: 0 0 12px;\n  color: var(--dsw-alias-label-tertiary);\n  overflow-wrap: anywhere;\n}\n\n.dsh-codex-budget-metrics {\n  display: grid;\n  gap: 4px;\n  margin: 0 0 12px;\n  font-variant-numeric: tabular-nums;\n}\n\n.dsh-codex-budget-metrics > div {\n  display: grid;\n  grid-template-columns: 112px minmax(0, 1fr);\n  gap: 12px;\n}\n\n.dsh-codex-budget-metrics dt {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dsh-codex-budget-metrics dd {\n  margin: 0;\n  overflow-wrap: anywhere;\n}\n\n.dsh-codex-budget-tools {\n  display: flex;\n  flex-wrap: wrap;\n  gap: 4px 20px;\n  margin-bottom: 12px;\n}\n\n.dsh-codex-budget-tools > span {\n  display: inline-flex;\n  gap: 6px;\n}\n\n.dsh-codex-budget-tools > span > span,\n.dsh-codex-budget-seq {\n  color: var(--dsw-alias-label-tertiary);\n}\n\n.dsh-codex-budget code {\n  font-family: var(--dsw-font-family-mono, monospace);\n  font-size: inherit;\n}\n\n.dsh-codex-budget-records {\n  margin: 4px 0 0 22px;\n}\n\n.dsh-codex-budget-list {\n  max-height: 280px;\n  overflow: auto;\n}\n\n.dsh-codex-budget-record {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) auto auto;\n  align-items: center;\n  gap: 12px;\n  min-height: 32px;\n}\n\n.dsh-codex-budget-record code {\n  overflow: hidden;\n  text-overflow: ellipsis;\n  white-space: nowrap;\n}\n\n.dsh-codex-budget-original {\n  margin-top: 12px;\n}\n\n.dsh-codex-budget-original pre {\n  max-height: 400px;\n  margin: 4px 0;\n  padding: 12px 16px;\n  overflow: auto;\n  border: 0.5px solid var(--dsw-alias-border-l1);\n  border-radius: var(--dsw-radius-lg);\n  background: var(--dsw-alias-markdown-code-block);\n  color: var(--dsw-alias-label-primary);\n  font: var(--dsw-font-markdown-code-block-small);\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n}\n\n@media (max-width: 600px) {\n  .dsh-codex-budget-body {\n    margin-left: 6px;\n    padding-left: 10px;\n  }\n\n  .dsh-codex-budget-record {\n    gap: 6px;\n  }\n}\n\n.dsh-codex-report-items {\n  max-height: 360px;\n  overflow: auto;\n  margin: 8px 0;\n  padding-left: 20px;\n  overflow-wrap: anywhere;\n}\n.dsh-codex-report-items li { margin-bottom: 8px; }\n"

    const inject = ['slots', 'uiConversation', 'remote', 'remote.session']

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

    const budgetDefinition = definition(kind, 'plugin:codex-migration/request-budget')
    const reportDefinition = definition(reportKind, 'plugin:codex-migration/report')

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

    function apply(ctx) {
      ctx.effect(() => ctx.uiConversation.events.register(budgetDefinition))
      ctx.effect(() => ctx.uiConversation.events.register(reportDefinition))
      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
        name: 'conversation.chat.node', key: kind,
        inject: sessionId => ({
          async readOriginal(pair, address) {
            const result = await ctx.remote.session.page({
              address: address ?? { kind: 'session', sessionId }, throughSeq: pair.resultSeq,
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

    return { apply, inject }
  }
})
