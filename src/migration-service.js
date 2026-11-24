import { busyReason, explainError, isOwned } from './migration-errors.js'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { taskScope } from './withdraw.js'
import { TaskStore, atomicJSON } from './tasks.js'
import { discover, targetId } from './source.js'
import { conversationPreview } from './conversation-preview.js'
import { discoverGroups, freezeGroup, importGroup, load } from './groups.js'
import { directory } from './import.js'

const previewVersion = 2
const pending = new Set(['pending', 'incremental', 'cwd'])
const cutoffOf = frozen => frozen && ({ turns: frozen.count, line: frozen.line, at: frozen.cutoffAt })
const publicTask = task => ({ ...task, groups: task.groups.map(group => ({ root: group.root, title: group.title,
  members: (group.members ?? []).map(node => ({ id: node.id, parent: node.parent, depth: node.depth, cutoff: cutoffOf(node.frozen) })) })) })
const errorReason = explainError
export function filtered(rows, query = {}) {
  const search = String(query.search ?? '').toLowerCase()
  const directory = query.projectDir && resolve(query.projectDir)
  let start, end
  if (query.period === '7' || query.period === '30') {
    const today = new Date()
    end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime()
    start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1 - Number(query.period)).getTime()
  } else if (query.period === 'custom') {
    if (query.from) start = Date.parse(query.from + 'T00:00:00')
    if (query.to) {
      const lastDay = new Date(query.to + 'T00:00:00')
      end = lastDay.setDate(lastDay.getDate() + 1)
    }
  }
  function matchesType(row) {
    const flags = { side: row.sideConversation, automation: row.automation, review: row.review, exec: row.execSource }
    if (Array.isArray(query.types)) {
      const applicable = Object.keys(flags).filter(key => flags[key])
      return (applicable.length ? applicable : ['ordinary']).some(key => query.types.includes(key))
    }
    return !(query.hideSide && flags.side || query.hideAutomation && flags.automation || query.hideReview && flags.review || query.hideExec && flags.exec)
  }
  return rows.filter(row => (row.archived ? query.archived : !query.hideActive) && matchesType(row)
    && (!directory || (row.cwd && (row.cwd === directory || row.cwd.startsWith(directory === '/' ? '/' : directory + '/'))))
    && (start === undefined || Date.parse(row.recent) >= start)
    && (end === undefined || Date.parse(row.recent) < end)
    && (!query.filter || query.filter === 'all' || (query.filter === 'actionable' ? pending.has(row.status)
      : query.filter === 'attention' ? ['cwd', 'blocked'].includes(row.status) : row.status === query.filter))
    && (!search || [row.title, row.root, row.cwd, ...row.members.map(member => member.id)].join(' ').toLowerCase().includes(search)))
}

export class MigrationService {
  ctx
  store
  preview
  previousSourceRoot
  scanning = false
  scanError
  scanPromise
  progress
  retryScan
  runs = new Set()
  disposed = false
  constructor(ctx, store) { this.ctx = ctx; this.store = store }
  static async open(ctx, dir = join(resolveDshHome(), 'codex-migration')) {
    const store = await TaskStore.open(dir), service = new MigrationService(ctx, store)
    try {
      const cached = JSON.parse(await readFile(join(dir, 'preview.json'), 'utf8'))
      service.previousSourceRoot = cached.sourceRoot
      if (cached.version === previewVersion && Array.isArray(cached.rows)) service.preview = cached
    } catch (error) { if (error.code !== 'ENOENT') service.scanError = '上次预览缓存不可用，请重新扫描' }
    return service
  }
  busy() { return !!this.store.active() }
  launch(task) {
    const run = this.run(task).catch(async error => {
      try { await this.store.update(task, { state: 'interrupted', phase: '任务异常中断', error: errorReason(error) }) }
      catch { Object.assign(task, { state: 'interrupted', error: '无法保存任务进度，请检查磁盘和目录权限后重启 DSH' }) }
    })
    this.runs.add(run)
    void run.then(() => this.runs.delete(run), () => this.runs.delete(run))
    return run
  }
  async run(task) {
    for (const group of task.groups) {
      if (task.results[group.root]) continue
      if (task.state !== 'running') break
      this.store.progress(task, group.root, group.root, '读取源历史')
      let result
      try {
        result = await importGroup(this.ctx, group, { execute: true, previewDetails: false, requireCwd: task.requireCwd !== false,
          titles: new Map(group.members.map(member => [member.id, member.title])), cwd: task.cwd[group.root], runtime: task.runtime,
          shouldPause: () => task.state !== 'running',
          onPhase: (member, phase) => this.store.progress(task, group.root, member, phase),
          onMember: (member, receipt) => this.store.update(task, { checkpoints: {
            [member]: { status: receipt.status, target: receipt.id, at: Date.now(),
              wrote: receipt.status === '成功' || task.checkpoints[member]?.wrote === true || task.checkpoints[member]?.status === '成功' } } }),
        })
      } catch (error) { result = { root: group.root, status: '失败', reason: errorReason(error), results: [], failures: [] } }
      if (result.paused) break
      if (result.status === '失败' && isOwned(result.reason)) result.status = '阻塞'
      await this.store.update(task, { results: { [group.root]: result } })
    }
    await this.store.settle(task)
  }
  async scan(sourceRoot) {
    if (this.scanning) throw new Error('正在扫描，请等待当前扫描完成')
    this.scanning = true
    let root
    try { root = await directory(sourceRoot || this.preview?.sourceRoot || this.previousSourceRoot || process.env.CODEX_HOME || join(homedir(), '.codex')) }
    catch (error) { this.scanning = false; throw error }
    if (!root) { this.scanning = false; throw new Error('Codex 来源必须是 DSH 机器上已存在的绝对目录') }
    this.scanError = null
    this.scanPromise = this.buildPreview(root, new Set(), randomUUID(), progress => { this.progress = progress })
      .then(async preview => {
        if (!preview) return
        await atomicJSON(join(this.store.dir, 'preview.json'), preview)
        this.preview = preview
      }).catch(error => { this.scanError = errorReason(error) })
      .finally(() => { this.scanning = false; this.progress = undefined })
  }
  async buildPreview(root, selected, id, onProgress) {
    const { paths, titles } = await discover(true, root)
    const { groups, issues } = await discoverGroups(paths, selected, true)
    const rows = groups.map(group => {
      const first = group.members[0]
      return { root: group.root, title: titles.get(group.root) || group.root, cwd: first.meta.cwd ?? '',
        recent: first.meta.timestamp ?? '', archived: first.paths.every(path => path.includes('/archived_sessions/')),
        execSource: first.meta.source === 'exec' || (first.meta.source == null && first.meta.originator === 'codex_exec'),
        review: first.meta.source?.subagent === 'review', automation: first.meta.thread_source === 'automation', sideConversation: first.meta.attached_thread === true, status: 'checking', children: group.members.length - 1, target: targetId(group.root),
        members: group.members.map(node => ({ id: node.id, parent: node.parent, path: node.paths[0], depth: node.depth })) }
    })
    const progress = { id, sourceRoot: root, rows, issues }
    onProgress(progress)
    for (const [index, group] of groups.entries()) {
      if (this.disposed) return
      let result, frozenGroup
      try {
        const previewSources = new Map()
        frozenGroup = await freezeGroup(group, titles, previewSources)
        result = await importGroup(this.ctx, frozenGroup, { execute: false, titles, previewSources, previewDetails: false })
      } catch (error) { result = { root: group.root, status: '失败', reason: errorReason(error), results: [], failures: [] } }
      const first = group.members[0], member = result.results.find(item => item.source === group.root)
      const exists = await this.ctx.sessionPersistence.stat(targetId(group.root))
      const missingCwd = !exists && !await directory(first.meta.cwd)
      const owned = result.status === '待导入' && group.members.some(node =>
        (this.ctx.get('agents')?.list() ?? []).some(agent => agent.session.header.id === targetId(node.id)))
      if (owned) result.reason = busyReason
      const status = owned ? 'blocked' : result.status === '跳过' ? 'unchanged' : result.status !== '待导入' ? 'blocked'
        : missingCwd ? 'cwd' : result.results.some(item => item.status === '增量导入' || item.status === '恢复导入') ? 'incremental' : 'pending'
      Object.assign(rows[index], { review: rows[index].review || frozenGroup?.members[0]?.frozen?.review === true, root: group.root, title: member?.title || titles.get(group.root) || group.root,
        cwd: first.meta.cwd ?? '', recent: frozenGroup?.members[0]?.frozen?.recent ?? first.meta.timestamp ?? '', archived: first.paths.every(path => path.includes('/archived_sessions/')),
        status, turns: frozenGroup?.members.reduce((sum, node) => sum + (node.frozen?.count ?? 0), 0) ?? 0,
        children: group.members.length - 1, members: group.members.map(node => ({ id: node.id, parent: node.parent, path: node.paths[0], depth: node.depth, cutoff: cutoffOf(frozenGroup?.members.find(member => member.id === node.id)?.frozen) })),
        reason: result.reason ?? result.failures.map(failure => failure.reason).join('；'),
        notices: result.results.map(member => member.analysis?.summary.length ?? 0).reduce((sum, count) => sum + count, 0),
        imported: !!exists, result, lazyDetail: true, frozenGroup, missingCwd, target: targetId(group.root) })
    }
    rows.sort((a, b) => b.recent.localeCompare(a.recent))
    return { ...progress, version: previewVersion, scannedAt: Date.now() }
  }
  retryPreview(task) {
    if (!['completed', 'ended'].includes(task.state)) throw new Error('请先结束或继续原任务')
    const ids = task.groups.filter(group => !['成功', '跳过'].includes(task.results[group.root]?.status)).map(group => group.root)
    if (!ids.length) throw new Error('没有需要重试的会话')
    const previous = this.retryScan
    if (previous?.scanning) {
      if (previous.retryOf !== task.id) throw new Error('正在校验其他任务的重试范围，请稍后再试')
      return { ids, retryOf: task.id, previewId: previous.preview.id }
    }
    const id = randomUUID(), sourceRoot = task.sourceRoot
    const scope = { retryOf: task.id, scanning: true, preview: { id, sourceRoot, rows: [], issues: [] } }
    this.retryScan = scope
    scope.done = (async () => {
      if (!await directory(sourceRoot)) throw new Error('原任务的 Codex 来源目录已不可用')
      const preview = await this.buildPreview(sourceRoot, new Set(ids), id, progress => { scope.preview = progress })
      if (preview) scope.preview = preview
    })().catch(error => { scope.error = errorReason(error) }).finally(() => { scope.scanning = false })
    return { ids, retryOf: task.id, previewId: id }
  }
  view(query = {}) {
    const scope = query.retryOf === this.retryScan?.retryOf ? this.retryScan : undefined
    const visible = query.retryOf ? scope?.preview : this.progress ?? this.preview
    const rows = filtered(visible?.rows ?? [], query)
    const page = Math.max(0, Number(query.page) || 0), size = 20
    return { previewId: visible?.id, sourceRoot: visible?.sourceRoot ?? this.previousSourceRoot ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      ...(query.retryOf && { librarySourceRoot: this.preview?.sourceRoot ?? this.previousSourceRoot, libraryPreviewId: this.preview?.id }),
      scannedAt: query.retryOf ? visible?.scannedAt : this.preview?.scannedAt,
      scanning: query.retryOf ? !!scope?.scanning : this.scanning,
      scanError: query.retryOf ? (scope ? scope.error : '重试预览已更新，请在任务记录中重新预览') : this.scanError,
      directories: [...new Set((visible?.rows ?? []).map(row => row.cwd).filter(Boolean))].sort(),
      eligible: rows.filter(row => pending.has(row.status)).map(row => ({ id: row.root, cwd: row.status === 'cwd' })),
      total: rows.length, actionable: rows.filter(row => pending.has(row.status)).length,
      counts: Object.fromEntries(['checking', 'pending', 'incremental', 'unchanged', 'cwd', 'blocked'].map(status => [status, rows.filter(row => row.status === status).length])),
      page, rows: rows.slice(page * size, (page + 1) * size).map(({ frozenGroup, result, ...row }) => row),
      issues: visible?.issues ?? [], tasks: this.store.list().map(publicTask), active: this.store.active()?.id }
  }
  async submit(input) {
    const duplicate = input.requestId && this.store.list().find(task => task.requestId === input.requestId)
    if (duplicate) return publicTask(duplicate)
    const retry = input.retryOf === this.retryScan?.retryOf ? this.retryScan : undefined
    if (input.retryOf ? retry?.scanning : this.scanning) throw new Error('正在扫描，请等待校验完成')
    const preview = input.retryOf ? retry?.preview : this.preview
    if (input.retryOf && retry?.error) throw new Error(retry.error)
    if (!preview || input.previewId !== preview.id) throw new Error('预览已更新，请重新检查当前范围后导入')
    if (input.requireReady && !input.ids?.length) throw new Error('请选择要导入的对话')
    const scope = input.ids?.length ? preview.rows.filter(row => input.ids.includes(row.root)) : filtered(preview.rows, input.query)
    if (input.ids?.some(id => !scope.some(row => row.root === id))) throw new Error('选择的会话不在当前预览内')
    const rows = scope.filter(row => pending.has(row.status))
    if (!rows.length) throw new Error('当前范围内没有可导入的会话')
    const cwd = { ...(input.cwd ?? {}) }, blocked = {}
    for (const row of rows) if (row.missingCwd) {
      cwd[row.root] = await directory(cwd[row.root] || input.batchCwd)
      if (!cwd[row.root] && input.requireReady) throw new Error('替代工作目录无效，请重新指定后导入。')
      if (!cwd[row.root]) blocked[row.root] = { root: row.root, status: '阻塞', reason: '缺少有效工作目录。选择 DSH 机器上已存在的绝对目录后重试此项。', results: [], failures: [] }
    }
    // Request ID makes a lost submit response safe to retry across reconnections.
    const task = await this.store.create({ sourceRoot: preview.sourceRoot, previewId: preview.id, requestId: input.requestId,
      cwd, groups: rows.map(row => ({ ...row.frozenGroup, title: row.title })), retryOf: input.retryOf })
    if (Object.keys(blocked).length) await this.store.update(task, { results: blocked })
    this.launch(task); return publicTask(task)
  }
  async dispatch(input) {
    if (this.disposed) throw new Error('迁移服务已停止')
    switch (input.op) {
      case 'scan': await this.scan(input.sourceRoot); return this.view(input.query)
      case 'state': return this.view(input.query)
      case 'detail': {
        const preview = input.retryOf ? (input.retryOf === this.retryScan?.retryOf && this.retryScan.preview) : this.progress ?? this.preview
        const row = preview?.rows?.find(row => row.root === input.id)
        if (!row) throw new Error('未找到会话，请重新扫描')
        const { frozenGroup, ...detail } = row
        const previewSources = new Map()
        if (detail.imported === undefined) detail.imported = !!await this.ctx.sessionPersistence.stat(targetId(row.root))
        detail.subagents = frozenGroup?.members.filter(member => member.id !== row.root && (member.meta?.agent_path || member.meta?.agent_role || member.subagent)).length
        const parent = frozenGroup?.members.find(member => member.id === row.root)
        if (parent) {
          try {
            const source = await load(parent)
            previewSources.set(row.root, source)
            detail.messages = conversationPreview(source)
          } catch (error) { detail.previewError = errorReason(error) }
        }
        if (row.lazyDetail && frozenGroup) {
          const titles = new Map(frozenGroup.members.map(member => [member.id, member.title]))
          detail.result = await importGroup(this.ctx, frozenGroup, { execute: false, titles, previewSources })
          if (row.result?.reason && !detail.result.reason) detail.result.reason = row.result.reason
        }
        return detail
      }
      case 'directories': {
        const valid = []
        for (const path of new Set(input.paths)) if (typeof path === 'string' && await directory(path)) valid.push(path)
        return valid
      }
      case 'task-targets': {
        const task = this.store.get(input.id)
        const { written, current, withdrawn } = await taskScope(this.store, task)
        const targets = {}
        for (const group of task.groups) {
          const id = targetId(group.root)
          if ((current.includes(group.root) || task.results[group.root]?.status === '跳过') && await this.ctx.sessionPersistence.stat(id)) targets[group.root] = id
        }
        return { targets, written, withdrawn }
      }
      case 'submit': return this.submit(input)
      case 'task': return publicTask(this.store.get(input.id))
      case 'pause': {
        const task = this.store.get(input.id)
        if (task.state !== 'running') throw new Error('任务当前不在执行')
        await this.store.transition(task, ['running'], { state: 'pausing', phase: '正在完成当前成员后暂停' }); return publicTask(task)
      }
      case 'continue': {
        const task = this.store.get(input.id); await this.store.resume(task); this.launch(task); return publicTask(task)
      }
      case 'end': {
        const task = this.store.get(input.id)
        if (!['running', 'pausing', 'paused', 'interrupted'].includes(task.state)) throw new Error('任务已经结束')
        await this.store.transition(task, ['running', 'pausing', 'paused', 'interrupted'], { state: ['running', 'pausing'].includes(task.state) ? 'ending' : 'ended', phase: '结束任务，保留已导入数据' })
        return publicTask(task)
      }
      case 'retry': return this.retryPreview(this.store.get(input.id))
      default: throw new Error('未知迁移操作')
    }
  }
  async executeCommand(groups, options, signal) {
    const frozen = []
    for (const group of groups) frozen.push(await freezeGroup(group, options.titles))
    const cwd = {}
    for (const group of frozen) cwd[group.root] = options.cwd ?? options.fallbackCwd ?? process.cwd()
    const task = await this.store.create({ sourceRoot: resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
      groups: frozen, cwd, runtime: options.runtime, requireCwd: false, kind: 'command' })
    const pause = () => { void this.store.transition(task, ['running'], { state: 'pausing' }).catch(() => {}) }
    signal?.addEventListener('abort', pause, { once: true })
    if (signal?.aborted) pause()
    try { await this.launch(task); return task }
    finally { signal?.removeEventListener('abort', pause) }
  }
  async close() {
    this.disposed = true
    const task = this.store.active()
    if (task && task.state === 'running') await this.store.update(task, { state: 'pausing' })
    await Promise.allSettled([...this.runs, this.scanPromise, this.retryScan?.done])
    await this.store.close()
  }
}
