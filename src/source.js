import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const digest = value => createHash('sha256').update(value).digest('hex')
export const targetId = id => 'session-codex-' + digest(id)

async function* rollouts(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* rollouts(path)
    else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) yield path
  }
}

export async function discover(includeArchived) {
  const root = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'))
  const paths = []
  for (const dir of includeArchived ? ['sessions', 'archived_sessions'] : ['sessions']) {
    for await (const path of rollouts(join(root, dir))) paths.push(path)
  }
  const titles = new Map()
  const index = await readFile(join(root, 'session_index.jsonl'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  for (const line of index.split('\n')) {
    try {
      const { id, thread_name } = JSON.parse(line)
      if (id && typeof thread_name === 'string') titles.set(id, thread_name)
    } catch { /* An incomplete index entry is optional metadata. */ }
  }
  return { paths, titles }
}

export async function rolloutId(path) {
  const stream = createReadStream(path, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      const record = JSON.parse(line)
      if (record.type === 'session_meta' && typeof record.payload?.id === 'string' && record.payload.id) {
        return record.payload.id
      }
      throw new Error('首条记录缺少源会话 ID')
    }
    throw new Error('源会话文件为空')
  } finally {
    reader.close()
    stream.destroy()
  }
}

export async function readRollout(path) {
  const raw = await readFile(path, 'utf8')
  const lines = raw.split('\n')
  const rows = []
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (typeof row?.type !== 'string' || !row.payload || typeof row.payload !== 'object') throw new Error()
      rows.push({ row, line, lineNumber: index + 1 })
    } catch {
      if (index === lines.length - 1 && !raw.endsWith('\n') && !path.includes('/archived_sessions/')) {
        throw new Error('源文件末行不完整，等待 Codex 写完后重试')
      }
      throw new Error('源文件第 ' + (index + 1) + ' 行不是有效记录')
    }
  }
  const meta = rows.find(({ row }) => row.type === 'session_meta')?.row.payload
  if (typeof meta?.id !== 'string' || !meta.id) throw new Error('缺少源会话 ID')
  return { meta, rows, path }
}

export function splitTurns(source) {
  const hasLifecycle = source.rows.some(({ row }) =>
    row.type === 'event_msg' && ['task_started', 'turn_started', 'task_complete', 'turn_complete'].includes(row.payload.type))
  const turns = []
  let pending = []
  let started = false
  let hasAnswer = false
  function finish(reason) {
    if (pending.some(({ row }) => row.type === 'response_item' || row.type === 'event_msg' && row.payload.type === 'user_message')) {
      turns.push({ rows: pending, reason })
    }
    pending = []
    hasAnswer = false
    started = false
  }
  for (const item of source.rows) {
    const { type, payload } = item.row
    if (type === 'session_meta') continue
    if (type === 'event_msg' && ['task_started', 'turn_started'].includes(payload.type)) {
      if (started || hasAnswer) finish('interrupted')
      started = true
    }
    if (!hasLifecycle && hasAnswer && type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      finish('completed')
    }
    pending.push(item)
    if (type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' &&
        payload.phase !== 'commentary') hasAnswer = true
    if (type === 'event_msg' && ['task_complete', 'turn_complete', 'turn_aborted'].includes(payload.type)) {
      finish(payload.type === 'turn_aborted' ? 'aborted' : 'completed')
    }
  }
  const archived = source.path.split(sep).includes('archived_sessions')
  const incomplete = hasLifecycle && !archived && pending.some(({ row }) => row.type === 'response_item')
  if (!hasLifecycle || archived) finish(hasAnswer && !hasLifecycle ? 'completed' : 'interrupted')
  const hashes = ['']
  for (const turn of turns) {
    hashes.push(digest(hashes.at(-1) + '\n' + turn.rows.map(item => item.line).join('\n')))
  }
  return { turns, hashes, incomplete }
}
