import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createZstdDecompress } from 'node:zlib'
import { atomicJSON } from './tasks.js'
import { digest, targetId } from './source.js'

async function inspect(path, id) {
  const input = createReadStream(join(path, 'session.v4.jsonl.zstd'))
  const decoder = createZstdDecompress()
  input.on('error', error => decoder.destroy(error))
  const lines = createInterface({ input: input.pipe(decoder) })
  const hash = createHash('sha256')
  let header, source, title, importing = false, continued = false
  try {
    for await (const line of lines) {
      const event = JSON.parse(line)
      hash.update(line).update('\n')
      if (!header) {
        if (event.type !== 'session' || event.version !== 4 || event.id !== id) throw new Error('会话头无效')
        header = event
        continue
      }
      if (!source) {
        source = event.data?.source
        if (event.seq !== 0 || event.type !== 'codex-migration/begin' || event.ignorable !== true ||
            event.data?.version !== 1 || typeof source !== 'string' || targetId(source) !== id) throw new Error('无导入凭据')
        title = event.data.title
      }
      if (event.type === 'codex-migration/begin') importing = true
      else if (event.type === 'codex-migration/checkpoint') importing = false
      else if (!importing && ['turn/start', 'user/message', 'assistant/message'].includes(event.type)) continued = true
      if (event.type === 'session/title' && event.data?.title) title = event.data.title
    }
    if (!source || importing) throw new Error('缺少完整导入凭据')
    return { id, path, source, parent: header.parentSession, title: title || source, continued, hash: hash.digest('hex') }
  } finally { lines.close(); input.destroy(); decoder.destroy() }
}

export async function inventory(home) {
  const root = join(home, 'sessions'), entries = [], skipped = []
  const dirs = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const dir of dirs.filter(entry => entry.isDirectory())) {
    const parent = join(root, dir.name)
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^session-codex-[a-f0-9]{64}$/.test(entry.name)) continue
      try { entries.push(await inspect(join(parent, entry.name), entry.name)) }
      catch { skipped.push(entry.name) }
    }
  }
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const groups = new Map()
  for (const entry of entries) {
    let root = entry
    const seen = new Set()
    while (root?.parent && !seen.has(root.id)) { seen.add(root.id); root = byId.get(root.parent) }
    if (!root || root.parent) { skipped.push(entry.id); continue }
    if (!groups.has(root.source)) groups.set(root.source, { root: root.source, title: root.title, members: [] })
    groups.get(root.source).members.push({ ...entry, depth: seen.size })
  }
  return { groups: [...groups.values()], skipped }
}

export function taskRoots(task) {
  if (!['ended', 'completed'].includes(task.state)) throw new Error('请先结束任务，再撤回相关会话。')
  return task.groups.filter(group => group.members.some(member => task.checkpoints?.[member.id]?.wrote || task.checkpoints?.[member.id]?.status === '成功') ||
    task.results[group.root]?.results?.some(member => member.status === '成功')).map(group => group.root)
}

// The same Codex ID can be imported again after a withdrawal.
export async function taskScope(store, task) {
  const written = taskRoots(task)
  const receipt = await readFile(join(store.dir, '..', 'codex-withdraw-receipt.json'), 'utf8').then(JSON.parse).catch(error => {
    if (error.code === 'ENOENT') return {}
    throw error
  })
  const dates = new Map(Object.entries(receipt.withdrawalDates ?? {}))
  const record = (id, at) => dates.set(id, [...(dates.get(id) ?? []), at])
  for (const [id, at] of Object.entries(receipt.deletedAt ?? {})) record(id, at)
  const superseded = new Map()
  for (const other of store.list()) {
    for (const item of other.withdrawals ?? []) {
      for (const id of item.deleted ?? []) record(id, item.at)
    }
    if (other.createdAt <= task.createdAt) continue
    for (const group of other.groups) {
      if (other.results[group.root]?.results?.some(member => member.source === group.root && member.status === '成功' &&
        member.reason?.startsWith('首次导入'))) superseded.set(group.root, Math.min(other.createdAt, superseded.get(group.root) ?? Infinity))
    }
  }
  const withdrawn = written.filter(root => dates.get(targetId(root))?.some(at => at >= task.createdAt && at < (superseded.get(root) ?? Infinity)))
  const current = written.filter(root => !withdrawn.includes(root) && !superseded.has(root))
  return { written, current, withdrawn: withdrawn.length }
}

export function describe(group) {
  const members = [...group.members].sort((a, b) => a.id.localeCompare(b.id))
  return { root: group.root, title: group.title, members: members.map(({ id, title, continued, parent }) => ({ id, title, continued, child: !!parent })),
    scope: digest(JSON.stringify(members.map(m => [m.path, m.hash]))) }
}

export function selectVerified(groups, selection, confirmed) {
  if (!Array.isArray(selection) || !selection.length) throw new Error('请选择要永久删除的会话。')
  const selected = [], seen = new Set()
  for (const item of selection) {
    const group = groups.find(g => g.root === item.root)
    if (!group || seen.has(item.root) || describe(group).scope !== item.scope) throw new Error('会话或续聊内容已变化，请重新预览并确认。')
    if (group.members.some(m => m.continued) && confirmed !== true) throw new Error('请确认永久删除 DSH 续聊。')
    seen.add(item.root); selected.push(group)
  }
  return selected
}

export async function deleteVerified(home, request) {
  const { groups } = await inventory(home)
  const selected = selectVerified(groups, request.selection, request.confirmed)
  const deleted = [], failures = []
  for (const group of selected) {
    // Keep the root available for another attempt if removing a child fails.
    for (const member of [...group.members].sort((a, b) => b.depth - a.depth)) {
      try { await rm(member.path, { recursive: true }); deleted.push(member.id) }
      catch (error) { failures.push(member.id + '：' + error.code); break }
    }
  }
  if (deleted.length) {
    await rm(join(home, 'codex-migration', 'preview.json'), { force: true })
    const receipt = join(home, 'codex-withdraw-receipt.json')
    const previous = await readFile(receipt, 'utf8').then(JSON.parse).catch(error => {
      if (error.code === 'ENOENT') return { deleted: [] }
      throw error
    })
    const withdrawalDates = { ...previous.withdrawalDates }
    const at = Date.now()
    for (const id of deleted) withdrawalDates[id] = [...(withdrawalDates[id] ?? []), at]
    await atomicJSON(receipt, { ...previous, deleted: [...new Set([...previous.deleted, ...deleted])], withdrawalDates })
  }
  return { deleted, failures }
}
