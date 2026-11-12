import { diagnosticReason } from './migration-errors.js'
import reportCSS from './client.css'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Input, SegmentedTabs, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { GroupRow } from './client.js'
import css from './migration-ui.css'

const PANEL = 'codex-migration'
const labels = { pending: '待导入', incremental: '可增量', unchanged: '无新增', cwd: '需工作目录', blocked: '需处理',
  running: '执行中', pausing: '正在暂停', paused: '已暂停', interrupted: '中断待继续', ending: '正在结束', ended: '已结束', completed: '已完成' }
const actionable = row => ['pending', 'incremental', 'cwd'].includes(row.status)
const busy = task => ['running', 'pausing', 'ending'].includes(task?.state)
const button = (text, onClick, disabled = false, primary = false) => h(Button, { type: 'button', size: 'sm',
  variant: primary ? 'primary' : 'ghost', onClick, disabled }, text)
const date = value => value ? new Date(value).toLocaleString() : '尚未扫描'

function diagnostics(task) {
  // Explicit allowlist: never export event bodies, source metadata or attachments.
  return JSON.stringify({ id: task.id, state: task.state, sourceRoot: task.sourceRoot,
    results: Object.values(task.results).map(group => ({ root: group.root, status: group.status, reason: diagnosticReason(group.reason),
      members: group.results.map(member => ({ id: member.id, source: member.source, status: member.status,
        reason: diagnosticReason(member.reason), counts: member.analysis?.counts,
        positions: member.analysis?.items.map(item => ({ category: item.category, source: item.source, line: item.line, block: item.block })) })),
      failures: group.failures.map(item => ({ id: item.id, phase: item.phase, reason: diagnosticReason(item.reason) })) })),
    suggestion: '针对失败原因修复后刷新预览；写锁需等待 DSH 释放或保存工作后手动重启；冲突不会因重启解决。' }, null, 2)
}

export function applyMigrationUI(ctx) {
  const rpc = ctx.remote.codexMigration, workspace = ctx.uiWorkspace, layout = ctx.layout
  const listeners = new Set()
  let snapshot = { data: null, error: null, pending: false, notice: null }, query = { filter: 'all', search: '', archived: false, page: 0 }
  let disposed = false, polling = false, previousActive, revision = 0
  const emit = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  const call = async request => {
    const result = await rpc.request(JSON.stringify(request))
    if (!result.ok) throw new Error('连接异常，任务状态未知；恢复连接后会重新读取。')
    const envelope = JSON.parse(result.value)
    if (!envelope.ok) throw new Error(envelope.error)
    return envelope.value
  }
  const refresh = async () => {
    if (polling || disposed) return
    polling = true
    const requestedRevision = revision
    try {
      const data = await call({ op: 'state', query })
      if (requestedRevision !== revision) return
      const finished = previousActive && data.tasks.find(task => task.id === previousActive && !busy(task))
      emit({ data, error: null, ...(finished && { notice: 'Codex 迁移任务' + labels[finished.state] + '，在任务记录中查看结果。' }) })
      previousActive = data.active
      if (finished && !data.scanning) void call({ op: 'scan', sourceRoot: data.sourceRoot }).catch(() => {})
    } catch (error) { emit({ error: error.message }) }
    finally { polling = false; if (requestedRevision !== revision) void refresh() }
  }
  const actions = {
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    get: () => snapshot,
    querySnapshot: () => query,
    query: patch => { query = { ...query, ...patch }; revision++; emit({ data: snapshot.data && { ...snapshot.data, querying: true } }); void refresh() },
    async run(request) {
      emit({ pending: true, error: null })
      try { const result = await call(request); if (['submit', 'continue'].includes(request.op)) previousActive = result.id; await refresh(); return result }
      catch (error) { emit({ error: error.message }); throw error }
      finally { emit({ pending: false }) }
    },
    refresh,
    open: id => workspace.openSession(id),
    panel: () => layout.selectPanel(PANEL),
    dismiss: () => emit({ notice: null }),
  }
  ctx.effect(() => {
    const timer = setInterval(() => { void refresh() }, 2000)
    void refresh()
    return () => { disposed = true; clearInterval(timer) }
  }, 'codex migration polling')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
    inject: () => ({ actions }),
  }, MigrationPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL,
    label: () => 'Codex 迁移', order: 1, inject: () => ({ actions }),
  }, MigrationIcon))
  ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({ name: 'plugins.detail.actions', id: PANEL,
    inject: () => ({ actions }),
  }, PluginAction))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: PANEL,
    inject: () => ({ actions }),
  }, CompletionNotice))
}

function MigrationIcon({ size, actions }) {
  const { data } = useSyncExternalStore(actions.subscribe, actions.get)
  return h('span', { title: data?.active ? 'Codex 迁移：执行中' : 'Codex 迁移' },
    h(IconContextInjectionOutlineRegular, { size }), data?.active && h('span', { 'aria-label': '迁移执行中' }, ' ·'))
}
function PluginAction({ subject, actions }) {
  return subject?.pkg?.name === 'dsh-codex-migration' ? button('打开 Codex 迁移', actions.panel) : null
}
function CompletionNotice({ actions }) {
  const { notice } = useSyncExternalStore(actions.subscribe, actions.get)
  return notice && h('div', { className: 'cm-notice', role: 'status' }, h('style', null, css),
    h('span', null, notice), button('查看', actions.panel), button('关闭', actions.dismiss))
}

function TaskCard({ task, actions, onRetry }) {
  const [open, setOpen] = useState(false), [feedback, setFeedback] = useState('')
  const values = Object.values(task.results), done = values.length
  const act = op => { void actions.run({ op, id: task.id }).catch(() => {}) }
  const download = () => {
    const url = URL.createObjectURL(new Blob([diagnostics(task)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = task.id + '-diagnostics.json'
    link.hidden = true; document.body.appendChild(link); link.click(); link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback('已请求浏览器下载诊断；也可使用复制诊断。')
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(diagnostics(task)); setFeedback('诊断信息已复制') }
    catch { setFeedback('无法访问剪贴板，请下载诊断信息') }
  }
  return h('section', { className: 'cm-task', 'aria-label': '迁移任务 ' + task.id },
    h('div', { className: 'cm-row' }, h('strong', null, labels[task.state]), h('span', { className: 'cm-muted' }, date(task.createdAt)),
      button(open ? '收起' : '查看详情', () => setOpen(!open))),
    h('p', null, '已处理 ' + done + ' / ' + task.groups.length + ' 组 · 成功 ' + values.filter(x => x.status === '成功').length
      + ' · 跳过 ' + values.filter(x => x.status === '跳过').length + ' · 失败 ' + values.filter(x => x.status === '失败').length + ' · 阻塞 ' + values.filter(x => ['阻塞', '冲突'].includes(x.status)).length
      + ' · 部分完成 ' + values.filter(x => x.status === '部分完成').length),
    h('p', { className: 'cm-muted' }, task.phase + (task.currentMember ? ' · ' + task.currentMember : '')
      + ' · 已耗时 ' + Math.max(0, Math.floor(((busy(task) ? Date.now() : task.updatedAt) - task.createdAt) / 1000)) + ' 秒'),
    task.error && h('p', { role: 'alert' }, task.error),
    h('div', { className: 'cm-row' }, task.state === 'running' && button('暂停', () => act('pause')),
      ['paused', 'interrupted'].includes(task.state) && button('继续此任务', () => act('continue'), false, true),
      ['running', 'pausing', 'paused', 'interrupted'].includes(task.state) && button('结束任务', () => act('end')),
      ['completed', 'ended'].includes(task.state) && task.groups.some(group => !['成功', '跳过'].includes(task.results[group.root]?.status))
        && button('重新预览失败项', () => onRetry(task)),
      button('复制诊断', () => { void copy() }), button('下载诊断', download)),
    feedback && h('p', { role: 'status' }, feedback),
    ['running', 'pausing', 'paused', 'interrupted'].includes(task.state) && h('p', { className: 'cm-muted' }, '暂停会完成当前成员后停下；结束会释放未完成范围，已导入数据保留。关闭页面不会停止任务。'),
    open && h('div', { className: 'cm-details' }, h('p', null, task.id), task.retryOf && h('p', null, '重试自：' + task.retryOf), h('p', null, '来源：' + task.sourceRoot),
      task.groups.map(group => h('div', { key: group.root }, h('p', null, group.title || group.root),
        !task.results[group.root] && group.members.map(member => h('p', { key: member.id, className: 'cm-muted' },
          (member.parent ? '子 agent ' : '父会话 ') + member.id + ' · ' + (task.checkpoints[member.id]?.status ?? '未完成'))),
        task.results[group.root] && h(GroupRow, { group: task.results[group.root] }),
        task.results[group.root]?.results.some(member => member.source === group.root && ['成功', '跳过'].includes(member.status))
          && button('打开 DSH 会话', () => actions.open(task.results[group.root].results.find(member => member.source === group.root).id))))))
}

function MigrationPage({ actions }) {
  const { data, error, pending } = useSyncExternalStore(actions.subscribe, actions.get)
  const [tab, setTab] = useState('sessions'), [search, setSearch] = useState(actions.querySnapshot().search), [filter, setFilter] = useState(actions.querySnapshot().filter)
  const [source, setSource] = useState(''), [archived, setArchived] = useState(actions.querySnapshot().archived), [selected, setSelected] = useState([])
  const [cwd, setCwd] = useState(''), [cwdMap, setCwdMap] = useState({}), [details, setDetails] = useState(null), [retryOf, setRetryOf] = useState(null)
  const [info, setInfo] = useState(''), initialized = useRef(false), requestId = useRef(null)
  useEffect(() => {
    if (!data || initialized.current) return
    initialized.current = true; setSource(data.sourceRoot)
    if (!data.scanning) void actions.run({ op: 'scan', sourceRoot: data.sourceRoot }).catch(() => {})
  }, [data, actions])
  const changeQuery = patch => { setSelected([]); setRetryOf(null); actions.query({ ...patch, page: 0 }) }
  const submit = async () => {
    requestId.current ??= crypto.randomUUID()
    try {
      const task = await actions.run({ op: 'submit', previewId: data.previewId, ids: selected,
        query: { filter, search, archived }, batchCwd: cwd, cwd: cwdMap, retryOf, requestId: requestId.current })
      requestId.current = null; setSelected([]); setTab('tasks'); setInfo('任务已提交：' + task.id)
    } catch { /* Error remains visible; a lost response retains its idempotency key. */ }
  }
  const retry = async task => {
    try {
      await actions.run({ op: 'scan', sourceRoot: task.sourceRoot })
      const scope = await actions.run({ op: 'retry', id: task.id })
      actions.query({ search: '', filter: 'all', archived: true, page: 0 }); setSearch(''); setFilter('all'); setArchived(true)
      setSource(task.sourceRoot); setSelected(scope.ids); setRetryOf(task.id); setTab('sessions')
      setInfo('已选择原任务失败或未完成的会话。等待扫描完成后检查新预览，再点击导入。')
    } catch { /* Public action error is visible above. */ }
  }
  const active = data?.tasks.find(task => task.id === data.active)
  return h('div', { className: 'cm-page' }, h('style', null, css + reportCSS),
    h('header', { className: 'cm-header' }, h('h1', null, 'Codex 迁移'), h('p', { className: 'cm-muted' }, '将这台 DSH 机器上的 Codex 对话迁入 DSH。导入不会调用模型。')),
    h('div', { className: 'cm-body' },
      error && h('div', { className: 'cm-alert', role: 'alert' }, error,
        /task-/.test(error) && button('查看当前任务记录', () => setTab('tasks')), button('重新读取状态', () => { void actions.refresh() })),
      info && h('p', { role: 'status' }, info),
      active && h(TaskCard, { task: active, actions, onRetry: retry }),
      h(SegmentedTabs, { label: 'Codex 迁移视图', value: tab, onChange: setTab, size: 'sm', items: [
        { value: 'sessions', label: '会话列表', id: 'cm-sessions-tab', panelId: 'cm-sessions' },
        { value: 'tasks', label: '任务记录', id: 'cm-tasks-tab', panelId: 'cm-tasks' },
      ] }),
      tab === 'tasks' ? h('section', { role: 'tabpanel', id: 'cm-tasks', 'aria-labelledby': 'cm-tasks-tab' },
        data?.tasks.filter(task => task.id !== data.active).map(task => h(TaskCard, { key: task.id, task, actions, onRetry: retry })),
        !data?.tasks.length && h('p', { className: 'cm-empty' }, '还没有迁移任务。'))
        : h('section', { role: 'tabpanel', id: 'cm-sessions', 'aria-labelledby': 'cm-sessions-tab' },
          h('div', { className: 'cm-source' }, h('label', null, 'Codex 来源目录（DSH 机器）',
            h(Input, { value: source, onChange: e => setSource(e.target.value), placeholder: '/绝对路径/.codex', 'aria-label': 'Codex 来源目录' })),
            button(data?.scanning ? '正在扫描…' : '刷新预览', () => {
              setSelected([]); setRetryOf(null); void actions.run({ op: 'scan', sourceRoot: source }).catch(() => {})
            }, pending || data?.scanning)),
          h('p', { className: 'cm-muted' }, '完整预览来源：' + (data?.sourceRoot ?? '尚未读取') + ' · 上次扫描：' + date(data?.scannedAt) + (data?.scanning ? ' · 正在检查，暂时显示上次完整结果' : '')),
          data?.scanError && h('p', { role: 'alert' }, data.scanError),
          h('div', { className: 'cm-row cm-filters' }, h(Input, { value: search, placeholder: '搜索标题、会话 ID、路径', 'aria-label': '搜索会话',
            onChange: e => { setSearch(e.target.value); changeQuery({ search: e.target.value }) } }),
            h('select', { value: filter, 'aria-label': '状态筛选', onChange: e => { setFilter(e.target.value); changeQuery({ filter: e.target.value }) } },
              Object.entries({ all: '全部状态', actionable: '全部可执行', pending: '待导入', incremental: '可增量', unchanged: '无新增', attention: '需处理' })
                .map(([value, text]) => h('option', { key: value, value }, text))),
            h('label', { className: 'cm-row' }, h('input', { type: 'checkbox', checked: archived, onChange: e => { setArchived(e.target.checked); changeQuery({ archived: e.target.checked }) } }), '包含归档')),
          h('p', { className: 'cm-muted' }, '当前筛选共 ' + (data?.total ?? 0) + ' 组 · 待导入 ' + (data?.counts.pending ?? 0) + ' · 可增量 ' + (data?.counts.incremental ?? 0)
            + ' · 无新增 ' + (data?.counts.unchanged ?? 0) + ' · 需工作目录 ' + (data?.counts.cwd ?? 0) + ' · 需处理 ' + (data?.counts.blocked ?? 0)),
          h('div', { className: 'cm-actions' }, button(selected.length ? '导入所选 ' + selected.length + ' 组' : '导入当前筛选 ' + (data?.actionable ?? 0) + ' 组',
            () => { void submit() }, pending || data?.scanning || data?.querying || data?.scanError || source.trim().replace(/\/+$/, '') !== data?.sourceRoot?.replace(/\/+$/, '') || !data?.previewId || !!active || !(selected.length || data?.actionable), true),
            selected.length > 0 && button('取消选择', () => setSelected([])),
            h('span', { className: 'cm-muted' }, data?.querying ? '正在更新筛选范围…' : selected.length ? '仅导入所选父会话及其子 agent' : '范围包含所有分页，子 agent 随父会话迁入')),
          h('label', { className: 'cm-cwd' }, '原目录不存在时使用（仅首次导入；未指定的条目会阻塞，其他条目继续）', h(Input, { value: cwd, onChange: e => setCwd(e.target.value),
            placeholder: 'DSH 机器上已存在的绝对目录，可批量应用', 'aria-label': '替代工作目录' })),
          h('div', { className: 'cm-list' }, data?.rows.map(row => h('article', { key: row.root, className: 'cm-session' },
            h('input', { type: 'checkbox', 'aria-label': '选择 ' + row.title, disabled: !actionable(row), checked: selected.includes(row.root),
              onChange: e => setSelected(value => e.target.checked ? [...value, row.root] : value.filter(id => id !== row.root)) }),
            h('div', { className: 'cm-session-content' }, h('div', { className: 'cm-row' }, h('strong', null, row.title), h('span', { className: 'cm-status' }, labels[row.status])),
              h('p', { className: 'cm-muted cm-path' }, row.cwd || '未记录原工作目录'),
              h('p', { className: 'cm-muted' }, date(row.recent) + ' · ' + row.turns + ' 轮（组内合计） · ' + row.children + ' 个子 agent'),
              h('p', { className: 'cm-id' }, row.root),
              row.reason && row.status === 'blocked' && h('p', { className: 'cm-muted' }, row.reason),
              row.notices > 0 && h('p', { className: 'cm-muted' }, '迁移说明 ' + row.notices + ' 类（详见详情）')),
            button('详情', () => { void actions.run({ op: 'detail', id: row.root }).then(setDetails).catch(() => {}) }))),
            data && !data.rows.length && h('p', { className: 'cm-empty' }, data.scanning ? '正在生成完整预览…' : '此范围内没有会话。')),
          h('nav', { className: 'cm-row', 'aria-label': '会话分页' }, button('上一页', () => actions.query({ page: data.page - 1 }), !data?.page),
            h('span', { className: 'cm-muted' }, '第 ' + ((data?.page ?? 0) + 1) + ' 页 / ' + Math.max(1, Math.ceil((data?.total ?? 0) / 20))),
            button('下一页', () => actions.query({ page: data.page + 1 }), !data || (data.page + 1) * 20 >= data.total)),
          data?.issues.length > 0 && h('details', null, h('summary', null, '无法归组的源异常 ' + data.issues.length + ' 项'),
            data.issues.map((issue, i) => h('p', { key: i }, issue.id + '：' + issue.reason))),
          details && h('section', { className: 'cm-details', 'aria-label': '会话详情' }, h('div', { className: 'cm-row' }, h('h2', null, details.title), button('关闭详情', () => setDetails(null))),
            details.missingCwd && h('label', { className: 'cm-cwd' }, '此会话的替代工作目录', h(Input, { 'aria-label': '此会话的替代工作目录', value: cwdMap[details.root] ?? '', onChange: e => setCwdMap(value => ({ ...value, [details.root]: e.target.value })) })),
            h('p', null, '源 ID：' + details.root), h('p', null, '目标 ID：' + details.target),
            details.members.map(member => h('div', { key: member.id }, h('p', null, (member.parent ? '子 agent → 父 ' + member.parent + '：' : '父会话：') + member.id + ' · ' + member.path),
              member.cutoff && h('p', { className: 'cm-muted' }, '本次冻结截止：' + member.cutoff.turns + ' 轮 · 源第 ' + member.cutoff.line + ' 行 · ' + date(member.cutoff.at)))),
            h(GroupRow, { group: details.result }))))
  )
}
