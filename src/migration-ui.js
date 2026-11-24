import { t, setUILocale, formatDate } from './ui-locale.js'
import { diagnosticReason } from './migration-errors.js'
import reportCSS from './client.css'
import { createElement as h, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, SegmentedTabs, IconContextInjectionOutlineRegular } from './ui-controls.js'
import { GroupRow } from './client.js'
import css from './migration-ui.css'

const PANEL = 'codex-migration'
const labels = () => ({ checking: t('待校验', 'Awaiting check'), pending: t('待导入', 'Ready to import'), incremental: t('可增量', 'Updates available'), unchanged: t('无新增', 'Up to date'), cwd: t('需工作目录', 'Directory needed'), blocked: t('需处理', 'Needs attention'),
  running: t('执行中', 'Running'), pausing: t('正在暂停', 'Pausing'), paused: t('已暂停', 'Paused'), interrupted: t('中断待继续', 'Interrupted'), ending: t('正在结束', 'Ending'), ended: t('已结束', 'Ended'), completed: t('已完成', 'Completed') })
const actionable = row => ['pending', 'incremental', 'cwd'].includes(row.status)
const busy = task => ['running', 'pausing', 'ending'].includes(task?.state)
const button = (text, onClick, disabled = false, primary = false) => h(Button, { type: 'button', size: 'sm',
  variant: primary ? 'primary' : 'ghost', onClick, disabled }, text)
const types = () => ({ ordinary: t('普通', 'Ordinary'), side: t('侧边对话', 'Side conversation'), automation: t('自动化', 'Automation'), review: 'Review', exec: 'Codex Exec' })
function selectControl(props, ...options) {
  return h('span', { className: 'cm-select-control' }, h('select', props, ...options))
}

const date = value => value ? formatDate(value) : t('尚未扫描', 'Not scanned')

function diagnostics(task) {
  // Explicit allowlist: never export event bodies, source metadata or attachments.
  return JSON.stringify({ id: task.id, state: task.state, sourceRoot: task.sourceRoot,
    results: Object.values(task.results).map(group => ({ root: group.root, status: group.status, reason: diagnosticReason(group.reason),
      members: group.results.map(member => ({ id: member.id, source: member.source, status: member.status,
        reason: diagnosticReason(member.reason), counts: member.analysis?.counts,
        positions: member.analysis?.items.map(item => ({ category: item.category, source: item.source, line: item.line, block: item.block })) })),
      failures: group.failures.map(item => ({ id: item.id, phase: item.phase, reason: diagnosticReason(item.reason) })) })),
    suggestion: t('针对失败原因修复后刷新预览；写锁需等待 DSH 释放或保存工作后手动重启；冲突不会因重启解决。', 'Refresh the preview after resolving failures. Wait for write locks to clear. Restarting does not resolve conflicts.') }, null, 2)
}

export function applyMigrationUI(ctx) {
  setUILocale(ctx.locale)
  const rpc = ctx.remote.codexMigration, workspace = ctx.uiWorkspace, layout = ctx.layout
  const listeners = new Set()
  let snapshot = { data: null, error: null, pending: false, notice: null }, query = { filter: 'all', search: '', archived: false, hideSide: false, page: 0 }
  let disposed = false, polling = false, previousActive, revision = 0
  const emit = patch => { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener() }
  const call = async request => {
    const result = await rpc.request(JSON.stringify(request))
    if (!result.ok) throw new Error(t('连接异常，任务状态未知；恢复连接后会重新读取。', 'Connection lost. Task status will refresh after reconnection.'))
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
      emit({ data, error: null, ...(finished && { notice: t('Codex 迁移任务', 'Codex migration: ') + labels()[finished.state] + t('，在任务记录中查看结果。', '. See task history for results.') }) })
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
    directories: paths => call({ op: 'directories', paths }),
    taskTargets: id => call({ op: 'task-targets', id }),
    detail: id => call({ op: 'detail', id }),
    refresh,
    open: id => workspace.openSession(id),
    panel: () => layout.selectPanel(PANEL),
    dismiss: () => emit({ notice: null }),
  }
  ctx.effect(() => {
    const unsubscribe = ctx.locale?.subscribe(() => emit({}))
    const timer = setInterval(() => { void refresh() }, 2000)
    void refresh()
    return () => { disposed = true; unsubscribe?.(); clearInterval(timer) }
  }, 'codex migration polling')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL,
    inject: () => ({ actions }),
  }, MigrationPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL,
    label: () => t('Codex 迁移', 'Codex migration'), order: 1, inject: () => ({ actions }),
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
  return h('span', { title: data?.active ? t('Codex 迁移：执行中', 'Codex migration in progress') : t('Codex 迁移', 'Codex migration') },
    h(IconContextInjectionOutlineRegular, { size }), data?.active && h('span', { 'aria-label': t('迁移执行中', 'Migration in progress') }, ' ·'))
}
function PluginAction({ subject, actions }) {
  return subject?.pkg?.name === 'dsh-codex-migration' ? h('span', null, h('style', null, reportCSS), button(t('打开 Codex 迁移', 'Open Codex migration'), actions.panel)) : null
}
function CompletionNotice({ actions }) {
  const { notice } = useSyncExternalStore(actions.subscribe, actions.get)
  return notice && h('div', { className: 'cm-notice', role: 'status' }, h('style', null, css + reportCSS),
    h('span', null, notice), button(t('查看', 'View'), actions.panel), button(t('关闭', 'Close'), actions.dismiss))
}

function TaskCard({ task, actions, onRetry, onWithdraw }) {
  const [open, setOpen] = useState(false), [feedback, setFeedback] = useState('')
  const values = Object.values(task.results), done = values.length
  const [availability, setAvailability] = useState(null)
  const terminal = ['completed', 'ended'].includes(task.state)
  useEffect(() => {
    if (!terminal) return
    let current = true
    actions.taskTargets(task.id).then(value => { if (current) setAvailability(value) }).catch(() => {})
    return () => { current = false }
  }, [actions, terminal, task.id, task.updatedAt])
  const remaining = availability?.written.filter(id => availability.targets[id]).length
  const title = task.groups[0]?.title || t('未命名对话', 'Untitled conversation')
  const state = availability?.written.length && availability.withdrawn === availability.written.length ? t('已全部撤回', 'Fully withdrawn')
    : availability?.withdrawn > 0 ? t('已部分撤回', 'Partially withdrawn')
    : terminal && values.some(value => ['失败', '阻塞', '部分完成', '冲突'].includes(value.status)) ? t('含未完成项', 'Has unfinished items') : labels()[task.state]
  const act = op => { void actions.run({ op, id: task.id }).catch(() => {}) }
  const download = () => {
    const url = URL.createObjectURL(new Blob([diagnostics(task)], { type: 'application/json' }))
    const link = document.createElement('a'); link.href = url; link.download = task.id + '-diagnostics.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    setFeedback(t('已请求浏览器下载诊断；也可使用复制诊断。', 'Diagnostics download requested. You can also copy diagnostics.'))
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(diagnostics(task)); setFeedback(t('诊断信息已复制', 'Diagnostics copied')) }
    catch { setFeedback(t('无法访问剪贴板，请下载诊断信息', 'Clipboard unavailable. Download diagnostics instead.')) }
  }
  return h('section', { className: 'cm-task', 'aria-label': t('迁移任务 ', 'Migration task ') + task.id },
    h('div', { className: 'cm-row' }, h('strong', null, title + (task.groups.length > 1 ? t(' 等 ', ' · ') + task.groups.length + t(' 个对话', ' conversations') : '')), h('span', { className: 'cm-status' }, state), h('span', { className: 'cm-muted' }, date(task.createdAt)),
      button(open ? t('收起', 'Collapse') : t('查看详情', 'View details'), () => setOpen(!open))),
    h('p', null, t('已处理 ', 'Processed ') + done + ' / ' + task.groups.length + t(' 个对话 · 成功 ', ' conversations · Successful ') + values.filter(x => x.status === '成功').length
      + t(' · 跳过 ', ' · Skipped ') + values.filter(x => x.status === '跳过').length + t(' · 失败 ', ' · Failed ') + values.filter(x => x.status === '失败').length + t(' · 阻塞 ', ' · Blocked ') + values.filter(x => ['阻塞', '冲突'].includes(x.status)).length
      + t(' · 部分完成 ', ' · Partial ') + values.filter(x => x.status === '部分完成').length),
    h('p', { className: 'cm-muted' }, task.phase + (task.currentMember ? ' · ' + task.currentMember : '')
      + t(' · 已耗时 ', ' · Elapsed ') + Math.max(0, Math.floor(((busy(task) ? Date.now() : task.updatedAt) - task.createdAt) / 1000)) + t(' 秒', ' s')),
    task.error && h('p', { role: 'alert' }, task.error),
    h('div', { className: 'cm-row' }, task.state === 'running' && button(t('暂停', 'Pause'), () => act('pause')),
      ['paused', 'interrupted'].includes(task.state) && button(t('继续此任务', 'Resume task'), () => act('continue'), false, true),
      ['running', 'pausing', 'paused', 'interrupted'].includes(task.state) && button(t('结束任务', 'End task'), () => act('end')),
      ['completed', 'ended'].includes(task.state) && task.groups.some(group => !['成功', '跳过'].includes(task.results[group.root]?.status))
        && button(t('重新预览失败项', 'Preview unfinished items'), () => onRetry(task)),
      task.groups.length === 1 && availability?.targets[task.groups[0].root] && button(t('打开对话', 'Open conversation'), () => actions.open(availability.targets[task.groups[0].root])),
      !!remaining && button(t('撤回导入', 'Withdraw import'), () => onWithdraw({ taskId: task.id })),
      button(t('复制诊断', 'Copy diagnostics'), () => { void copy() }), button(t('下载诊断', 'Download diagnostics'), download)),
    task.withdrawals?.map((item, i) => h('p', { key: i }, date(item.at) + ' · ' + withdrawalResult(item.text))),
    feedback && h('p', { role: 'status' }, feedback),
    ['running', 'pausing', 'paused', 'interrupted'].includes(task.state) && h('p', { className: 'cm-muted' }, t('暂停会完成当前成员后停下；结束会释放未完成范围，已导入数据保留。关闭页面不会停止任务。', 'Pausing finishes the current item first. Ending releases unfinished work and keeps imported data. Closing this page leaves the task running.')),
    open && h('div', { className: 'cm-details' }, h('p', null, task.id), task.retryOf && h('p', null, t('重试自：', 'Retry of: ') + task.retryOf), h('p', null, t('来源：', 'Source: ') + task.sourceRoot),
      task.groups.map(group => h('div', { key: group.root, className: 'cm-task-detail-group' }, h('p', null, group.title || group.root),
        !task.results[group.root] && group.members.map(member => h('p', { key: member.id, className: 'cm-muted' },
          (member.parent ? t('关联对话 ', 'Related conversation ') : t('对话 ', 'Conversation ')) + member.id + ' · ' + (task.checkpoints[member.id]?.status ?? t('未完成', 'Unfinished')))),
        task.results[group.root] && h(GroupRow, { group: task.results[group.root] }),
        availability?.targets[group.root]
          && button(t('打开 DSH 对话', 'Open DSH conversation'), () => actions.open(availability.targets[group.root]))))))
}

function MessageExcerpt({ message }) {
  const [expanded, setExpanded] = useState(false)
  const long = message.text.length > 240
  return h('div', { className: 'cm-excerpt' }, h('strong', null, message.label),
    h('p', null, long && !expanded ? message.text.slice(0, 240) + '…' : message.text),
    long && button(expanded ? t('收起原文', 'Collapse text') : t('展开原文', 'Expand text'), () => setExpanded(!expanded)))
}

function SessionDetails({ details, actions, close, cwdMap, setCwdMap, onWithdraw }) {
  const [detail, setDetail] = useState(null), [error, setError] = useState('')
  const waiting = details.status === 'checking'
  useEffect(() => {
    if (waiting) return
    let current = true
    actions.detail(details.root).then(value => { if (current) setDetail(value) })
      .catch(cause => { if (current) setError(cause.message) })
    return () => { current = false }
  }, [actions, details.root, waiting])
  const result = detail?.result
  const members = result?.results ?? []
  const parent = details.members.find(member => member.id === details.root)
  const extra = detail?.subagents ? t('导入时会一并导入 ', 'Also imports ') + detail.subagents + t(' 个子代理（subagent）对话。', ' subagent conversations.') : ''
  let scope
  if (details.status === 'unchanged') scope = t('没有新增轮次，本次跳过。', 'No new turns. This conversation will be skipped.')
  else if (details.status === 'blocked') scope = t('当前无法导入。', 'Cannot import this conversation.')
  else if (details.status === 'incremental' && result) scope = t('本次将追加 ', 'This import adds ') + members.reduce((n, m) => n + (m.turns ?? 0), 0) + t(' 轮。', ' turns. ') + extra
  else if (parent?.cutoff && details.status !== 'incremental') scope = t('此对话 ', 'Conversation length: ') + parent.cutoff.turns + t(' 轮。', ' turns. ') + extra
  const problems = new Set()
  if (details.status === 'blocked') problems.add(details.reason || t('请查看技术信息中的迁移报告。', 'See the migration report in technical details.'))
  for (const failure of result?.failures ?? []) problems.add((failure.id === details.root ? t('此对话', 'This conversation') : t('关联对话 ', 'Related conversation ') + failure.id) + '：' + failure.reason)
  if (result?.reason && result.status === '冲突') problems.add(result.reason)
  const missing = members.reduce((n, m) => n + (m.analysis?.counts?.['attachment-missing'] ?? 0), 0)
  if (missing) problems.add(t('有 ', 'There are ') + missing + t(' 条附件记录无法迁移，详情见技术信息。', ' attachment records that cannot be migrated. See technical details.'))
  return h('section', { className: 'cm-details', 'aria-label': t('对话详情', 'Conversation details') },
    h('h2', null, t('对话预览', 'Conversation preview')),
    detail?.messages?.map(message => h(MessageExcerpt, { key: message.line, message })),
    detail && !detail.messages?.length && h('p', null, detail.previewError || t('预览范围内没有可显示的对话正文。', 'No conversation text in this preview.')),
    error && h('p', { role: 'alert' }, error),
    !detail && !error && h('p', { role: 'status' }, waiting ? t('等待此对话校验', 'Waiting for verification') : t('正在读取对话…', 'Reading conversation…')),
    scope && h('div', null, h('h2', null, t('本次导入', 'Import scope')), h('p', null, scope)),
    (details.missingCwd || problems.size > 0) && h('div', null, h('h2', null, t('需要处理的问题', 'Needs attention')),
      [...problems].map(problem => h('p', { key: problem }, problem)),
      details.missingCwd && h('label', { className: 'cm-cwd' }, t('原工作目录不可用：', 'Original directory unavailable: ') + (details.cwd || t('未记录', 'Unknown')) + t('。请选择替代目录。', '. Choose a replacement directory.'),
        h('input', { 'aria-label': t('此对话的替代工作目录', 'Replacement directory for this conversation'), value: cwdMap[details.root] ?? '', onChange: e => setCwdMap(value => ({ ...value, [details.root]: e.target.value })) }))),
    h('details', null, h('summary', null, t('技术信息', 'Technical details')), h('p', null, t('源 ID：', 'Source ID: ') + details.root), h('p', null, t('目标 ID：', 'Target ID: ') + details.target),
      details.members.map(member => h('div', { key: member.id }, h('p', null, (member.parent ? t('关联对话（所属对话 ', 'Related conversation (owner ') + member.parent + '）：' : t('对话：', 'Conversation: ')) + member.id + ' · ' + member.path),
        member.cutoff && h('p', null, t('冻结截止：', 'Snapshot: ') + member.cutoff.turns + t(' 轮 · 源第 ', ' turns · source line ') + member.cutoff.line + t(' 行 · ', ' · ') + date(member.cutoff.at)))),
      result && h(GroupRow, { group: result })), h('div', { className: 'cm-row cm-detail-actions' }, (details.imported || detail?.imported) && button(t('撤回此对话', 'Withdraw this conversation'), () => onWithdraw({ root: details.root })), button(t('收起详情', 'Collapse details'), close)))
}

function CleanupPanel({ actions, pending, active, scope }) {
  const [preview, setPreview] = useState(null), [selected, setSelected] = useState([])
  const [result, setResult] = useState('')
  const [confirmed, setConfirmed] = useState(false), [submitted, setSubmitted] = useState(false)
  const inspect = async () => {
    setPreview(null); setSelected([]); setConfirmed(false)
    try {
      const data = await actions.run({ op: 'cleanup-preview', ...scope })
      setPreview(data); setSubmitted(false)
      if (data.previousId && sessionStorage.getItem('cm-withdraw-request') === data.previousId && !data.previous?.startsWith('已提交')) {
        setResult(data.previous); sessionStorage.removeItem('cm-withdraw-request')
      }
      if (scope.root && data.rows.length === 1) setSelected([scope.root])
    } catch { /* Page displays the error. */ }
  }
  useEffect(() => { void inspect() }, [scope])
  const groups = preview?.rows.filter(g => selected.includes(g.root)) ?? []
  const hasContinuation = group => group.members.some(member => member.continued)
  const continued = groups.filter(hasContinuation).length
  const execute = async () => {
    if (!groups.length || (continued && !confirmed)) return
    try {
      const requestId = crypto.randomUUID()
      await actions.run({ op: 'cleanup-execute', ...scope, confirmed, requestId,
        selection: groups.map(({ root, scope }) => ({ root, scope })) })
      sessionStorage.setItem('cm-withdraw-request', requestId); setResult(''); setSubmitted(true)
    } catch { setPreview(null) }
    setConfirmed(false)
  }
  return h('section', { role: 'tabpanel', id: 'cm-cleanup', 'aria-labelledby': 'cm-cleanup-tab' },
    h('h2', null, scope.taskId ? t('撤回任务相关对话', 'Withdraw conversations from task') : scope.root ? t('撤回此对话', 'Withdraw this conversation') : t('撤回已导入对话', 'Withdraw imported conversations')),
    h('p', null, t('将永久删除所选对话的完整历史。即使任务只追加了几轮，更早导入的历史也将一并删除。', 'Withdrawal permanently deletes the entire selected DSH history, including history imported before this task.')),
    button(t('刷新预览', 'Refresh preview'), inspect, pending),
    result && h('p', { role: 'status' }, result),
    submitted && h('p', { role: 'status' }, t('已提交删除。Web 重启后可重新预览结果。', 'Deletion submitted. Check the result after Web restarts.')),
    preview && !submitted && h('div', { className: 'cm-details' },
      !preview.rows.length && h('p', null, t('当前范围没有可核验且可删除的导入对话。', 'No verified imports available for withdrawal.')),
      preview.skipped > 0 && h('p', null, t('有 ', 'There are ') + preview.skipped + t(' 条导入记录无法核验，已排除。', ' unverified import records excluded.')),
      preview.rows.length > 0 && h('label', { className: 'cm-select-page' },
        h('input', { type: 'checkbox', checked: groups.length === preview.rows.length,
          ref: node => { if (node) node.indeterminate = groups.length > 0 && groups.length < preview.rows.length },
          onChange: event => { setConfirmed(false); setSelected(event.target.checked ? preview.rows.map(row => row.root) : []) } }),
        t('全选当前范围', 'Select all in scope') + ' (' + preview.rows.length + ')'),
      preview.rows.map(group => h('div', { key: group.root, className: 'cm-cleanup-row' },
        h('label', null, h('input', { type: 'checkbox', checked: selected.includes(group.root),
          onChange: e => { setConfirmed(false); setSelected(e.target.checked ? [...selected, group.root] : selected.filter(id => id !== group.root)) } }), group.title),
        group.taskEffect && h('p', null, group.taskEffect),
        hasContinuation(group) && h('span', { className: 'cm-status' }, t('已续聊', 'Continued in DSH')))),
      groups.length > 0 && h('p', null, t('已选 ', 'Selected ') + groups.length + t(' 个对话。撤回后，所选对话将从 DSH 删除，Codex 中的原始记录会保留。Web 将短暂重启。', ' conversations. Withdrawal deletes them from DSH and preserves the Codex originals. Web will restart briefly.')),
      continued > 0 && h('div', { className: 'cm-warning', role: 'status' }, t('选中的 ', 'Of the ') + groups.length + t(' 个对话中，有 ', ' selected conversations, ') + continued + t(' 个已在 DSH 续聊。撤回后，新增的续聊内容将永久丢失。', ' have new DSH turns. Withdrawing permanently deletes those turns.')),
      continued > 0 && h('label', null, h('input', { type: 'checkbox', checked: confirmed, onChange: e => setConfirmed(e.target.checked) }),
        t('我确认永久删除这些对话及其 DSH 续聊', 'I confirm permanent deletion of these conversations and their DSH continuations')),
      button(t('确认撤回', 'Confirm withdrawal'), execute, !groups.length || pending || !!active || (continued && !confirmed)),
      active && h('p', null, t('请等待迁移任务结束后再删除。', 'Wait for the migration task to finish before deleting.'))))
}

function withdrawalResult(text) {
  // Older receipts counted stored sessions and cannot supply a conversation count.
  if (/^已永久删除 \d+ 条会话。/.test(text)) {
    if (text.includes('Web 重启失败')) return t('Web 重启失败，请手动运行 dsh-start，并重新预览撤回结果。', 'Web restart failed. Run dsh-start and refresh the withdrawal preview.')
    return text.includes('失败') ? t('部分对话未完整撤回，请重新预览。', 'Some conversations were not fully withdrawn. Refresh the preview.') : t('已完成撤回。', 'Withdrawal completed.')
  }
  return text
}

function MigrationPage({ actions }) {
  const [withdrawScope, setWithdrawScope] = useState(/** @type {{root?: string, taskId?: string}} */ ({}))
  const withdraw = scope => { setWithdrawScope(scope); setTab('cleanup') }
  const { data, error, pending } = useSyncExternalStore(actions.subscribe, actions.get)
  const [tab, setTab] = useState(() => sessionStorage.getItem('cm-withdraw-request') ? 'cleanup' : 'sessions'), [search, setSearch] = useState(actions.querySnapshot().search), [filter, setFilter] = useState(actions.querySnapshot().filter)
  const [source, setSource] = useState(''), [archived, setArchived] = useState(actions.querySnapshot().archived), [selected, setSelected] = useState([])
  const q = actions.querySnapshot()
  const visibleTypes = q.types ?? Object.keys(types())
  const adjusted = archived || q.hideActive || visibleTypes.length !== Object.keys(types()).length
  const [cwd, setCwd] = useState(''), [cwdMap, setCwdMap] = useState({}), [details, setDetails] = useState(null), [retryOf, setRetryOf] = useState(null)
  const [info, setInfo] = useState(''), initialized = useRef(false), requestId = useRef(null)
  useEffect(() => {
    if (!data || initialized.current) return
    initialized.current = true; setSource(data.sourceRoot)
    if (!data.previewId && !data.scanning) void actions.run({ op: 'scan', sourceRoot: data.sourceRoot }).catch(() => {})
  }, [data, actions])
  const changeQuery = patch => { requestId.current = null; setInfo(selected.length ? t('筛选已更改，已清空选择。', 'Filters changed. Selection cleared.') : ''); setDetails(null); setSelected([]); setRetryOf(null); actions.query({ ...patch, page: 0 }) }
  const eligible = data?.eligible ?? []
  const choices = eligible.filter(item => selected.includes(item.id))
  const [validPaths, setValidPaths] = useState([])
  const pathsKey = JSON.stringify([...new Set(choices.filter(item => item.cwd).map(item => cwdMap[item.id] || cwd).filter(Boolean))].sort())
  useEffect(() => {
    let current = true
    const paths = JSON.parse(pathsKey)
    const timer = setTimeout(() => {
      if (paths.length) actions.directories(paths).then(valid => { if (current) setValidPaths(valid) }).catch(() => { if (current) setValidPaths([]) })
    }, 200)
    return () => { current = false; clearTimeout(timer) }
  }, [actions, pathsKey])
  const missing = choices.filter(item => item.cwd && !validPaths.includes(cwdMap[item.id] || cwd))
  const ready = choices.filter(item => !missing.includes(item))
  const pageIds = (data?.rows ?? []).filter(actionable).map(row => row.root)
  const checkedPage = pageIds.filter(id => selected.includes(id)).length
  const submit = async () => {
    if (!ready.length) return
    const signature = JSON.stringify([data.previewId, ready.map(item => item.id), cwd, cwdMap, retryOf])
    if (requestId.current?.signature !== signature) requestId.current = { signature, id: crypto.randomUUID() }
    try {
      const task = await actions.run({ op: 'submit', previewId: data.previewId, ids: ready.map(item => item.id), requireReady: true,
        query: actions.querySnapshot(), batchCwd: cwd, cwd: cwdMap, retryOf, requestId: requestId.current.id })
      requestId.current = null; setSelected([]); setTab('tasks'); setInfo(t('任务已提交：', 'Task submitted: ') + task.id)
    } catch { /* Error remains visible; a lost response retains its idempotency key. */ }
  }
  const retry = async task => {
    try {
      await actions.run({ op: 'scan', sourceRoot: task.sourceRoot })
      const scope = await actions.run({ op: 'retry', id: task.id })
      actions.query({ search: '', filter: 'all', archived: true, hideActive: false, types: Object.keys(types()), hideSide: false, hideReview: false, hideExec: false, hideAutomation: false, projectDir: '', period: '', from: '', to: '', page: 0 }); setSearch(''); setFilter('all'); setArchived(true)
      setSource(task.sourceRoot); setSelected(scope.ids); setRetryOf(task.id); setTab('sessions')
      setInfo(t('已选择原任务失败或未完成的对话。等待扫描完成后检查新预览，再点击导入。', 'Unfinished conversations selected. Check the new preview after scanning, then import.'))
    } catch { /* Public action error is visible above. */ }
  }
  const active = data?.tasks.find(task => task.id === data.active)
  return h('div', { className: 'cm-page' }, h('style', null, css + reportCSS),
    h('header', { className: 'cm-header' }, h('h1', null, t('Codex 迁移', 'Codex migration')), h('p', { className: 'cm-muted' }, t('将这台 DSH 机器上的 Codex 对话迁入 DSH。导入不会调用模型。', 'Import local Codex conversations into DSH. Importing makes no model calls.'))),
    h('div', { className: 'cm-body' },
      error && h('div', { className: 'cm-alert', role: 'alert' }, error,
        /task-/.test(error) && button(t('查看当前任务记录', 'View current task'), () => setTab('tasks')), button(t('重新读取状态', 'Refresh status'), () => { void actions.refresh() })),
      info && h('p', { role: 'status' }, info),
      active && h(TaskCard, { task: active, actions, onRetry: retry, onWithdraw: withdraw }),
      h(SegmentedTabs, { label: t('Codex 迁移视图', 'Codex migration views'), value: tab, onChange: value => { if (value === 'cleanup') setWithdrawScope({}); setTab(value) }, items: [
        { value: 'sessions', label: t('对话列表', 'Conversations'), id: 'cm-sessions-tab', panelId: 'cm-sessions' },
        { value: 'cleanup', label: t('撤回导入', 'Withdraw import'), id: 'cm-cleanup-tab', panelId: 'cm-cleanup' },
        { value: 'tasks', label: t('任务记录', 'Task history'), id: 'cm-tasks-tab', panelId: 'cm-tasks' },
      ] }),
      tab === 'cleanup' ? h(CleanupPanel, { key: withdrawScope.root || withdrawScope.taskId || 'all', actions, pending, active, scope: withdrawScope }) : tab === 'tasks' ? h('section', { role: 'tabpanel', id: 'cm-tasks', 'aria-labelledby': 'cm-tasks-tab' },
        data?.tasks.filter(task => task.id !== data.active).map(task => h(TaskCard, { key: task.id, task, actions, onRetry: retry, onWithdraw: withdraw })),
        !data?.tasks.length && h('p', { className: 'cm-empty' }, t('还没有迁移任务。', 'No migration tasks yet.')))
        : h('section', { role: 'tabpanel', id: 'cm-sessions', 'aria-labelledby': 'cm-sessions-tab' },
          h('div', { className: 'cm-source' }, h('label', null, t('Codex 来源目录（DSH 机器）', 'Codex source directory on the DSH host'),
            h('input', { value: source, onChange: e => setSource(e.target.value), placeholder: t('/绝对路径/.codex', '/absolute/path/.codex'), 'aria-label': t('Codex 来源目录', 'Codex source directory') })),
            button(data?.scanning ? t('正在扫描…', 'Scanning…') : t('刷新预览', 'Refresh preview'), () => {
              setSelected([]); setDetails(null); setRetryOf(null); void actions.run({ op: 'scan', sourceRoot: source }).catch(() => {})
            }, pending || data?.scanning)),
          h('p', { className: 'cm-muted' }, t('预览来源：', 'Preview source: ') + (data?.sourceRoot ?? t('尚未读取', 'Not loaded')) + t(' · 上次完成：', ' · Last completed: ') + date(data?.scannedAt) + (data?.scanning ? t(' · 正在扫描并校验', ' · Scanning and verifying') : '')),
          data?.scanError && h('p', { role: 'alert' }, data.scanError),
          h('div', { className: 'cm-row cm-filters' }, h('input', { value: search, placeholder: t('搜索标题、对话 ID、路径', 'Search by title, conversation ID or path'), 'aria-label': t('搜索对话', 'Search conversations'),
            onChange: e => { setSearch(e.target.value); changeQuery({ search: e.target.value }) } }),
            selectControl({ value: filter, 'aria-label': t('状态筛选', 'Filter by status'), onChange: e => { setFilter(e.target.value); changeQuery({ filter: e.target.value }) } },
              Object.entries({ all: t('全部状态', 'All statuses'), actionable: t('全部可执行', 'All eligible'), pending: t('待导入', 'Ready to import'), incremental: t('可增量', 'Updates available'), unchanged: t('无新增', 'Up to date'), attention: t('需处理', 'Needs attention') })
                .map(([value, text]) => h('option', { key: value, value }, text))),
            h('details', { className: 'cm-filter-menu', onKeyDown: e => {
              if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary').focus() }
            }, onBlur: e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false } },
              h('summary', null, adjusted ? t('筛选 · 已调整', 'Filters · modified') : t('筛选', 'Filters')),
              h('div', { className: 'cm-filter-popup' },
                h('fieldset', null, h('legend', null, t('归档状态', 'Archive status')),
                  h('label', null, h('input', { type: 'checkbox', checked: !q.hideActive, onChange: e => changeQuery({ hideActive: !e.target.checked }) }), t('未归档', 'Unarchived')),
                  h('label', null, h('input', { type: 'checkbox', checked: archived, onChange: e => { setArchived(e.target.checked); changeQuery({ archived: e.target.checked }) } }), t('已归档', 'Archived'))),
                h('fieldset', null, h('legend', null, t('对话类型', 'Conversation types')), Object.entries(types()).map(([key, label]) =>
                  h('label', { key }, h('input', { type: 'checkbox', checked: visibleTypes.includes(key),
                    onChange: e => changeQuery({ types: e.target.checked ? [...visibleTypes, key] : visibleTypes.filter(type => type !== key) }) }), label))),
                button(t('恢复默认', 'Restore defaults'), () => { setArchived(false); changeQuery({ archived: false, hideActive: false, types: Object.keys(types()) }) })))),
          h('div', { className: 'cm-row cm-filters' },
            h('label', null, t('项目目录 ', 'Project directory '), selectControl({ value: q.projectDir || '', onChange: e => changeQuery({ projectDir: e.target.value }) },
              h('option', { value: '' }, t('全部目录', 'All directories')), (data?.directories ?? []).map(dir => h('option', { key: dir, value: dir }, dir)))),
            h('label', null, t('最近活动 ', 'Recent activity '), selectControl({ value: q.period || '', onChange: e => changeQuery({ period: e.target.value }) },
              Object.entries({ '': t('不限时间', 'Any time'), '7': t('最近 7 天', 'Last 7 days'), '30': t('最近 30 天', 'Last 30 days'), custom: t('自定义日期', 'Custom dates') }).map(([value, label]) => h('option', { key: value, value }, label)))),
            q.period === 'custom' && h('label', null, t('从 ', 'From '), h('input', { type: 'date', value: q.from || '', max: q.to || undefined, onChange: e => changeQuery({ from: e.target.value }) })),
            q.period === 'custom' && h('label', null, t('至 ', 'To '), h('input', { type: 'date', value: q.to || '', min: q.from || undefined, onChange: e => changeQuery({ to: e.target.value }) }))),
          q.period === 'custom' && q.from && q.to && q.from > q.to && h('p', { role: 'alert' }, t('开始日期应早于或等于结束日期。', 'Start date must be on or before the end date.')),
          h('p', { className: 'cm-muted' }, (archived ? t('含归档', 'Includes archived') : t('未含归档', 'Excludes archived')) + t(' · 当前筛选共 ', ' · Matching conversations: ') + (data?.total ?? 0) + t(' 个对话', ' conversations') + (data?.counts.checking ? t(' · 待校验 ', ' · Awaiting check: ') + data.counts.checking : '') + t(' · 待导入 ', ' · Ready: ') + (data?.counts.pending ?? 0) + t(' · 可增量 ', ' · Updates: ') + (data?.counts.incremental ?? 0)
            + t(' · 无新增 ', ' · Up to date: ') + (data?.counts.unchanged ?? 0) + t(' · 需工作目录 ', ' · Directory needed: ') + (data?.counts.cwd ?? 0) + t(' · 需处理 ', ' · Needs attention: ') + (data?.counts.blocked ?? 0)),
          h('div', { className: 'cm-actions' }, button(!choices.length ? t('导入所选对话', 'Import selected conversations') : (missing.length ? t('仅导入可执行的 ', 'Import eligible only: ') : t('导入所选 ', 'Import selected: ')) + ready.length + t(' 个对话', ' conversations'),
            () => { void submit() }, pending || data?.scanning || data?.querying || data?.scanError || source.trim().replace(/\/+$/, '') !== data?.sourceRoot?.replace(/\/+$/, '') || !data?.previewId || !!active || !ready.length, true),
            button(t('选择全部筛选结果（', 'Select all matching (') + eligible.length + t('）', ')'), () => setSelected(eligible.map(item => item.id)), !eligible.length || data?.querying || data?.scanning),
            choices.length > 0 && button(t('清空选择', 'Clear selection'), () => setSelected([])),
            h('span', { className: 'cm-muted', role: 'status' }, t('已选 ', 'Selected ') + choices.length + t(' 个对话，', ' conversations, ') + ready.length + t(' 个可导入，', ' ready, ') + missing.length + t(' 个待指定工作目录', ' need a working directory'))),
          h('label', { className: 'cm-cwd' }, t('批量指定替代工作目录（仅用于原目录不可用的对话）', 'Replacement directory for conversations with an unavailable original directory'), h('input', { value: cwd, onChange: e => setCwd(e.target.value),
            placeholder: t('DSH 机器上已存在的绝对目录，可批量应用', 'Existing absolute directory on the DSH host'), 'aria-label': t('替代工作目录', 'Replacement working directory') })),
          h('label', { className: 'cm-select-page' }, h('input', { type: 'checkbox', checked: pageIds.length > 0 && checkedPage === pageIds.length,
            ref: node => { if (node) node.indeterminate = checkedPage > 0 && checkedPage < pageIds.length },
            disabled: !pageIds.length || data?.querying, onChange: e => setSelected(e.target.checked ? [...new Set([...selected, ...pageIds])] : selected.filter(id => !pageIds.includes(id))) }), t('全选本页可导入对话', 'Select eligible conversations on this page')),
          h('div', { className: 'cm-list' }, data?.rows.map(row => h('div', { key: row.root }, h('article', { className: 'cm-session' },
            h('input', { type: 'checkbox', 'aria-label': t('选择 ', 'Select ') + row.title, disabled: !actionable(row), checked: selected.includes(row.root),
              onChange: e => setSelected(value => e.target.checked ? [...value, row.root] : value.filter(id => id !== row.root)) }),
            h('div', { className: 'cm-session-content' }, h('div', { className: 'cm-row' }, h('strong', null, row.title === row.root ? t('未命名对话', 'Untitled conversation') : row.title)),
              h('p', { className: 'cm-muted cm-path' }, row.cwd || t('未记录原工作目录', 'No original directory recorded')),
              h('p', { className: 'cm-muted' }, date(row.recent) + (row.sideConversation ? t(' · 侧边对话', ' · Side conversation') : '') + (row.review ? ' · Review' : '') + (row.execSource ? ' · Codex Exec' : ''))),
            h('span', { className: 'cm-status' }, labels()[row.status]),
            button(details === row.root ? t('收起', 'Collapse') : t('详情', 'Details'), () => setDetails(details === row.root ? null : row.root))),
            details === row.root && h(SessionDetails, { key: data.previewId + row.root, details: row, actions, close: () => setDetails(null), cwdMap, setCwdMap, onWithdraw: withdraw }))),
            data && !data.rows.length && h('p', { className: 'cm-empty' }, data.scanning ? t('正在生成完整预览…', 'Preparing preview…') : t('此范围内没有对话。', 'No conversations match.'), !data.scanning && button(t('清除筛选', 'Clear filters'), () => { setSearch(''); setFilter('all'); setArchived(true); changeQuery({ search: '', filter: 'all', archived: true, hideActive: false, types: Object.keys(types()), projectDir: '', period: '', from: '', to: '' }) }))),
          h('nav', { className: 'cm-row', 'aria-label': t('对话分页', 'Conversation pages') }, button(t('上一页', 'Previous'), () => actions.query({ page: data.page - 1 }), !data?.page),
            h('span', { className: 'cm-muted' }, t('第 ', 'Page ') + ((data?.page ?? 0) + 1) + t(' 页 / ', ' / ') + Math.max(1, Math.ceil((data?.total ?? 0) / 20))),
            button(t('下一页', 'Next'), () => actions.query({ page: data.page + 1 }), !data || (data.page + 1) * 20 >= data.total)),
          data?.issues.length > 0 && h('details', null, h('summary', null, t('无法关联的对话 ', 'Unlinked conversations: ') + data.issues.length + t(' 项', ' items')),
            data.issues.map((issue, i) => h('p', { key: i }, issue.id + '：' + issue.reason)))))

  )
}
