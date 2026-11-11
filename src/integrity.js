import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// Storage backends can reorder object keys. Array order and every JSON value
// remain part of the receipt, including message roles, sources and attachments.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export function storageHash(events) {
  return createHash('sha256').update(JSON.stringify(canonical(events))).digest('hex')
}

export function assertStoredBatch(expected, actual) {
  const normalized = JSON.parse(JSON.stringify(expected))
  if (normalized.length !== actual.length) throw new Error('存储保真校验失败：迁移记录数量不一致')
  const index = normalized.findIndex((event, index) => !isDeepStrictEqual(event, actual[index]))
  if (index >= 0) throw new Error('存储保真校验失败：迁移记录 seq ' + normalized[index].seq + ' 的内容不一致')
}

export function completedImports(events) {
  const batches = []
  let start
  for (const [index, event] of events.entries()) {
    if (event.type === 'codex-migration/begin') {
      if (start !== undefined) throw new Error('存储保真校验失败：迁移批次边界不完整')
      start = index
    }
    if (event.type !== 'codex-migration/checkpoint') continue
    if (start === undefined) throw new Error('存储保真校验失败：检查点缺少迁移起点')
    const begin = events[start]
    if (begin.data.count !== event.data.count || begin.data.hash !== event.data.hash || begin.data.source !== event.data.source) {
      throw new Error('存储保真校验失败：迁移检查点与起点不一致')
    }
    if (event.data.storageHash && storageHash(events.slice(start, index)) !== event.data.storageHash) {
      throw new Error('存储保真校验失败：已导入内容在 seq ' + begin.seq + '–' + event.seq + ' 之间发生变化')
    }
    batches.push({ start, end: index, receipt: event.data.storageHash })
    start = undefined
  }
  // An unfinished last batch is checked against regenerated events by recovery.
  return batches
}
