import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const executing = new Set(['running', 'pausing', 'ending'])
const reserved = new Set([...executing, 'paused', 'interrupted'])
export async function atomicJSON(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(value)); await file.sync() }
  finally { await file.close() }
  try {
    await rename(temp, path)
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } finally { await rm(temp, { force: true }) }
}

// The store owns one data-directory lease. Serializing short metadata writes
// does not queue import jobs: a second executing task is always rejected.
export class TaskStore {
  dir
  records = new Map()
  serial = Promise.resolve()
  lock
  static async open(dir) {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const store = new TaskStore(); store.dir = dir
    // SQLite's exclusive transaction is an OS-backed local lease. It has no
    // stale-file deletion race and is released automatically on process death.
    const lock = new DatabaseSync(join(dir, 'coordination.sqlite'))
    try { lock.exec('BEGIN EXCLUSIVE') }
    catch (error) { lock.close(); throw new Error('此 DSH 数据目录已有迁移服务运行：' + error.code) }
    store.lock = lock
    try {
      for (const name of await readdir(dir)) {
        if (!/^task-[a-f0-9-]+\.json$/.test(name)) continue
        const record = JSON.parse(await readFile(join(dir, name), 'utf8'))
        store.records.set(record.id, record)
        if (executing.has(record.state)) await store.update(record, { state: 'interrupted', phase: '服务曾中断，等待手动继续' })
      }
      return store
    } catch (error) { await store.close(); throw error }
  }
  transaction(fn) {
    const result = this.serial.then(fn)
    this.serial = result.catch(() => {})
    return result
  }
  get(id) { const task = this.records.get(id); if (!task) throw new Error('未找到迁移任务'); return task }
  list() { return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt) }
  active() { return this.list().find(task => executing.has(task.state)) }
  check(groups, except) {
    const active = this.active()
    if (active && active.id !== except) throw new Error('已有任务正在执行：' + active.id)
    const ids = new Set(groups.map(group => group.root))
    const owner = this.list().find(task => task.id !== except && reserved.has(task.state)
      && task.groups.some(group => !task.results[group.root] && ids.has(group.root)))
    if (owner) throw new Error('会话由未结束任务保留，请继续原任务：' + owner.id)
  }
  async persist(task) { await atomicJSON(join(this.dir, task.id + '.json'), task); return task }
  create(input) {
    return this.transaction(async () => {
      this.check(input.groups)
      const task = { ...input, id: 'task-' + randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
        state: 'running', phase: '准备', results: {}, checkpoints: {} }
      await this.persist(task); this.records.set(task.id, task)
      return task
    })
  }
  update(task, patch) {
    return this.transaction(async () => {
      const next = { ...task, ...patch, updatedAt: Date.now() }
      await this.persist(next); Object.assign(task, next)
      return task
    })
  }
  transition(task, allowed, patch) {
    return this.transaction(async () => {
      if (!allowed.includes(task.state)) throw new Error('任务状态已变化，请重新读取任务')
      const next = { ...task, ...patch, updatedAt: Date.now() }
      await this.persist(next); Object.assign(task, next); return task
    })
  }
  settle(task) {
    return this.transaction(async () => {
      const state = task.state === 'ending' ? 'ended' : task.state === 'pausing' ? 'paused' : 'completed'
      const next = { ...task, state, currentMember: null, currentGroup: null, updatedAt: Date.now(),
        phase: state === 'completed' ? '已完成' : state === 'paused' ? '已暂停' : '已结束' }
      await this.persist(next); Object.assign(task, next); return task
    })
  }
  resume(task) {
    return this.transaction(async () => {
      if (!['paused', 'interrupted'].includes(task.state)) throw new Error('仅暂停或中断的任务可以继续')
      this.check(task.groups.filter(group => !task.results[group.root]), task.id)
      const next = { ...task, state: 'running', phase: '准备恢复', updatedAt: Date.now() }
      await this.persist(next); Object.assign(task, next); return task
    })
  }
  async close() {
    await this.serial
    if (this.lock) { this.lock.close(); this.lock = undefined }
  }
}
