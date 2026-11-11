import { configuredServers, dependencies } from './dependencies.js'
import { MigrationReport } from './report.js'
import { refreshImportedSidebar } from './sidebar.js'
import { attachImportedWorkspace } from './workspaces.js'
import { isDeepStrictEqual } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { convertTurns, epoch, titleFor } from './convert.js'
import { splitTurns, targetId } from './source.js'
import { assertStoredBatch, completedImports, storageHash } from './integrity.js'

const BEGIN = 'codex-migration/begin'
const END = 'codex-migration/checkpoint'

async function directory(path) {
  if (!path || !isAbsolute(path)) return undefined
  try {
    const canonical = await realpath(path)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch { return undefined }
}

function plan(source, parsed, events) {
  const checkpoint = events.findLast(event => event.type === END)
  const begin = events.findLast(event => event.type === BEGIN)
  const count = checkpoint?.data.count ?? 0
  const recovery = begin && (!checkpoint || begin.seq > checkpoint.seq) ? begin : undefined
  const fail = reason => ({ status: '冲突', reason })
  if ((events.length && !begin) || (begin && begin.data.source !== source.meta.id)) return fail('目标会话 ID 已被占用')
  if (count > parsed.turns.length || checkpoint && parsed.hashes[count] !== checkpoint.data.hash) {
    return fail('已导入的 Codex 历史被改写或截断')
  }
  const stop = recovery?.data.count ?? parsed.turns.length
  if (recovery && parsed.hashes[stop] !== recovery.data.hash) return fail('中断导入对应的源历史已变化')
  if (!recovery && count === stop) return { status: '跳过', reason: parsed.incomplete ? '没有可导入的新轮次，Codex 末轮尚未结束' : 'Codex 无新增对话' }
  if (!recovery && events.slice((checkpoint?.seq ?? -1) + 1).some(event => event.type === 'turn/start')) {
    return fail('Codex 与 DSH 两边均新增了对话')
  }
  return { status: recovery ? '恢复导入' : count ? '增量导入' : '首次导入', count, stop, recovery }
}

function eventBuilder(before, createdAt) {
  const events = []
  let time = before.at(-1)?.time ?? createdAt
  const emit = (type, data, timestamp, extras) => {
    time = Math.max(time, epoch(timestamp, time))
    const event = { seq: emit.next(), time, type, data, ...extras }
    events.push(event)
    return event
  }
  emit.next = () => before.length + events.length
  return { events, emit }
}

async function build(ctx, source, parsed, action, before, header, title, runtime) {
  const { emit, events } = eventBuilder(before, header.createdAt)
  const gaps = new MigrationReport(source.path)
  const marker = { version: 1, source: source.meta.id, count: action.stop, hash: parsed.hashes[action.stop] }
  // A retry of a partially written old batch must reproduce its exact events.
  const conversionVersion = action.recovery ? action.recovery.data.conversionVersion ?? 1 : 4
  const extraEvents = action.recovery?.data.extraEvents
  runtime = action.recovery ? action.recovery.data.runtime : runtime
  emit(BEGIN, { ...marker, ...(conversionVersion > 1 && { conversionVersion }), title, originalCwd: extraEvents ? action.recovery.data.originalCwd : source.meta.cwd ?? null,
    ...(header.origin && runtime && { runtime }),
    ...(extraEvents && { extraEvents }) }, undefined, { ignorable: true })
  if (extraEvents) {
    for (const { type, data, ...extras } of extraEvents) emit(type, data, undefined, extras)
    emit(END, { ...marker, storageHash: storageHash(events) }, undefined, { ignorable: true })
    return { events, gaps }
  }
  if (!action.count && title) emit('session/title', { title, source: { kind: 'user' }, messageSeqs: [] })
  let descriptorAdded = before.length > 0 || header.origin !== 'subagent'
  const nativeEmit = (type, data, time, extras) => {
    const result = emit(type, data, time, extras)
    if (!descriptorAdded && type === 'turn/start') {
      descriptorAdded = true
      emit('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'codex-migration',
        label: source.meta.agent_path ?? source.meta.agent_role ?? title ?? source.meta.id,
        ...(runtime && { agentProvider: runtime.provider, agentModel: runtime.model,
          ...(runtime.reasoningEffort && { agentReasoningEffort: runtime.reasoningEffort }) }) }, time)
    }
    return result
  }
  nativeEmit.next = emit.next
  await convertTurns(ctx, source, parsed.turns.slice(0, action.stop), action.count, nativeEmit, gaps, conversionVersion)
  emit(END, { ...marker, storageHash: storageHash(events) }, undefined, { ignorable: true })
  return { events, gaps }
}

export async function importSession(ctx, source, options) {
  const { meta } = source
  const id = targetId(meta.id)
  const parsed = splitTurns(source)
  const title = titleFor(source, options.title)
  const dependencyList = dependencies(source, configuredServers(ctx))
  const original = await directory(meta.cwd)
  const alternative = await directory(options.cwd)
  if (options.cwd && !alternative) throw new Error('指定的 --cwd 必须是已存在的绝对目录')
  const fallback = await directory(options.fallbackCwd) ?? await directory(process.cwd())
  const cwd = original ?? alternative ?? fallback
  const persistence = ctx.sessionPersistence
  const snapshot = await persistence.stat(id)
  let handle = options.handle
  try {
    if (snapshot && !handle) handle = await persistence.open(id, options.execute ? 'write' : 'read')
    const current = handle ? (await handle.read()).events : []
    const action = plan(source, parsed, current)
    if (handle && (handle.header.parentSession !== options.parentSession ||
      (handle.header.origin === 'subagent') !== !!options.parentSession)) {
      return { id, title, status: '冲突', reason: '目标会话父子归属与源历史不一致' }
    }
    if (action.status !== '冲突') {
      try {
        const batches = completedImports(current)
        if (options.execute) {
          let count = 0
          for (const batch of batches) {
            if (!batch.receipt) {
              const begin = current[batch.start]
              const expected = await build(ctx, source, parsed,
                { count, stop: begin.data.count, recovery: begin }, current.slice(0, batch.start), handle.header, begin.data.title)
              assertStoredBatch(expected.events.slice(0, -1), current.slice(batch.start, batch.end))
            }
            count = current[batch.end].data.count
          }
        }
      } catch (error) {
        return { id, title, status: '冲突', reason: error.message }
      }
    }
    let analysis
    if (!options.execute && action.status !== '冲突') {
      const dry = { get: name => name === 'attachments' ? {
        saveImage: async () => ({ preview: true }), saveFile: async () => ({ preview: true }),
      } : ctx.get(name) }
      const scan = await build(dry, source, parsed, { count: 0, stop: parsed.turns.length }, [], { createdAt: 0 }, title)
      analysis = scan.gaps.toJSON()
    }
    if (!options.execute || action.reason) return { id, title, dependencies: dependencyList, ...action, ...(analysis && { analysis }), incomplete: parsed.incomplete,
      ...(action.stop !== undefined ? { turns: action.stop - action.count } : {}),
      gaps: !snapshot && !original && cwd ? ['原工作目录不可用，目标目录：' + cwd + '（可用 --cwd 指定）'] : [] }
    options.signal?.throwIfAborted()
    const header = handle?.header ?? {
      id, version: 4, isSeeded: false, delegationDepth: options.depth ?? 0,
      ...(options.parentSession && { origin: 'subagent', parentSession: options.parentSession }),
      createdAt: epoch(meta.timestamp, epoch(parsed.turns[0]?.rows[0]?.row.timestamp)),
      ...(cwd ? { cwd } : {}),
    }
    const recovery = action.recovery
    const before = recovery ? current.slice(0, recovery.seq) : current
    const batch = await build(ctx, source, parsed, action, before, header,
      recovery ? recovery.data.title : action.count ? null : title, options.runtime)
    const storedTail = current.slice(before.length)
    if (storedTail.length && !isDeepStrictEqual(JSON.parse(JSON.stringify(storedTail)), batch.events.slice(0, storedTail.length))) {
      return { id, title, status: '冲突', reason: '中断导入留下的记录与本次迁移不一致' }
    }
    options.signal?.throwIfAborted()
    handle ??= await persistence.create(header)
    options.onHandle?.(handle)
    await handle.append(batch.events.slice(storedTail.length))
    await handle.flush()
    const stored = (await handle.read()).events
    assertStoredBatch(batch.events, stored.slice(before.length))
    if (!options.keepOpen) { await handle.close(); handle = undefined }
    // A fresh read performs the native backend's v4 admission again.
    const reader = await persistence.open(id, 'read')
    let observation
    try {
      observation = { header: reader.header, inheritedEventCount: reader.inheritedEventCount,
        events: (await reader.read()).events }
    } finally { await reader.close() }
    assertStoredBatch(batch.events, observation.events.slice(before.length))
    if (!original && !action.count && header.cwd) {
      batch.gaps.add('原工作目录不可用，已保留原路径；目标目录：' + header.cwd)
    }
    const attached = await directory(header.cwd)
    const workspaces = ctx.get('workspaceRegistry')
    if (attached && workspaces && !header.origin) {
      try {
        await attachImportedWorkspace(workspaces, attached, id)
      } catch (error) { batch.gaps.add('关联 DSH 工作区失败：' + error.message) }
    } else if (!attached) {
      batch.gaps.add('原工作目录不可用。可在首次导入时通过 --cwd 指定现有目录')
    }
    try {
      if (!header.origin) refreshImportedSidebar(ctx, observation, observation.events)
    } catch (error) {
      batch.gaps.add('刷新 DSH 侧边栏标题失败：' + error.message)
    }
    return { id, title, dependencies: dependencyList, status: '成功', reason: action.status + ' ' + (action.stop - action.count) + ' 轮 · 存储保真校验通过',
      analysis: batch.gaps.toJSON(), gaps: [...batch.gaps], incomplete: parsed.incomplete }
  } finally {
    if (!options.keepOpen) await handle?.close()
  }
}


// Relation and missing-history facts use the same durable, recoverable receipt
// protocol as transcript batches. A retry reproduces extraEvents verbatim.
export async function appendMetadata(ctx, handle, extraEvents) {
  const { events: before } = await handle.read()
  const end = before.findLast(event => event.type === END)
  if (!end) throw new Error('迁移元数据缺少完整历史检查点')
  const { emit, events } = eventBuilder(before, handle.header.createdAt)
  const marker = { version: 1, source: end.data.source, count: end.data.count, hash: end.data.hash }
  emit(BEGIN, { ...marker, conversionVersion: 4, title: null, originalCwd: null, extraEvents }, undefined, { ignorable: true })
  for (const { type, data, ...extras } of extraEvents) emit(type, data, undefined, extras)
  emit(END, { ...marker, storageHash: storageHash(events) }, undefined, { ignorable: true })
  await handle.append(events); await handle.flush()
  assertStoredBatch(events, (await handle.read()).events.slice(before.length))
  const reader = await ctx.sessionPersistence.open(handle.id, 'read')
  try { assertStoredBatch(events, (await reader.read()).events.slice(before.length)) }
  finally { await reader.close() }
}
