import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'
import { readRollout, targetId, splitTurns, digest } from './source.js'
import { importSession, appendMetadata } from './import.js'
import { refreshImportedSidebar } from './sidebar.js'

function parentOf(meta) {
  const spawn = meta.source?.subagent?.thread_spawn
  const child = meta.thread_source === 'subagent' || !!spawn || (!!meta.parent_thread_id && meta.thread_source !== 'user')
  return child ? meta.parent_thread_id ?? spawn?.parent_thread_id ?? null : undefined
}

async function metadata(path) {
  const stream = createReadStream(path, { encoding: 'utf8' }), reader = createInterface({ input: stream })
  try {
    for await (const line of reader) {
      if (!line.trim()) continue
      const row = JSON.parse(line)
      if (row.type !== 'session_meta' || !row.payload?.id) throw new Error('首条记录缺少源会话 ID')
      return row.payload
    }
    throw new Error('源会话为空')
  } finally { reader.close(); stream.destroy() }
}

export async function discoverGroups(paths, selected, includeArchived) {
  const nodes = new Map(), issues = []
  for (const path of paths) {
    try {
      const meta = await metadata(path), parent = parentOf(meta)
      const old = nodes.get(meta.id)
      if (old) {
        old.paths.push(path)
        if (parent !== old.parent) old.error = '同一源会话的父级归属相互矛盾'
      } else nodes.set(meta.id, { id: meta.id, meta, parent, paths: [path], children: [] })
    } catch (error) {
      if (!selected.size || [...selected].some(id => path.endsWith('-' + id + '.jsonl'))) issues.push({ id: path.split('/').at(-1), reason: error instanceof SyntaxError ? '源元数据不是有效 JSON' : error.message })
    }
  }
  for (const node of nodes.values()) if (node.parent !== undefined) {
    const parent = nodes.get(node.parent)
    if (!parent) node.error = '缺少父会话历史：' + String(node.parent)
    else parent.children.push(node)
  }
  const groups = []
  const included = new Set()
  function visit(node, path, depth, members) {
    if (path.has(node.id)) { node.error = '子 agent 关系存在循环'; return }
    included.add(node.id)
    members.push({ ...node, depth })
    for (const child of node.children) visit(child, new Set([...path, node.id]), depth + 1, members)
  }
  for (const node of nodes.values()) {
    if (node.parent !== undefined || selected.size && !selected.has(node.id)) continue
    if (!selected.size && !includeArchived && node.paths.every(p => p.includes('/archived_sessions/'))) continue
    const members = []; visit(node, new Set(), 0, members)
    groups.push({ root: node.id, members })
  }
  for (const id of selected) if (!groups.some(g => g.root === id)) {
    const node = nodes.get(id)
    issues.push({ id, reason: node?.parent ? '这是子 agent，请选择父会话导入组：' + node.parent : '未找到可选择的根会话' })
  }
  if (!selected.size) for (const node of nodes.values()) {
    if (node.parent !== undefined && !included.has(node.id)) issues.push({ id: node.id, reason: node.error ?? '无法归属到可导入根会话（关系循环或缺少父历史）' })
  }
  return { groups, issues }
}

export class FrozenSourceError extends Error {}

export async function load(node) {
  try { return await loadMember(node) }
  catch (error) {
    if (node.frozen) throw new FrozenSourceError('预览范围内的源历史无法重现：' + error.message)
    throw error
  }
}

async function loadMember(node) {
  if (node.error) throw new Error(node.error)
  let source
  for (const path of node.paths) {
    const copy = await readRollout(path, node.frozen?.line)
    if (copy.meta.id !== node.id) throw new Error('扫描后源会话 ID 已变化')
    if (source) {
      if (copy.rows.every((x, i) => x.line === source.rows[i]?.line)) continue
      if (!source.rows.every((x, i) => x.line === copy.rows[i]?.line)) throw new Error('同一源会话 ID 有不同的历史文件')
    }
    source = copy
  }
  if (node.frozen) {
    const parsed = splitTurns(source), { count, hash, metaHash } = node.frozen
    if (digest(JSON.stringify(source.meta)) !== metaHash || parsed.hashes[count] !== hash) {
      throw new Error('预览范围内的源历史被改写或截断，请重新扫描')
    }
    const last = parsed.turns[count - 1]?.rows.at(-1)?.lineNumber ?? 1
    source = { ...source, rows: source.rows.filter(item => item.lineNumber <= last) }
  }
  return source
}

export async function freezeMember(node) {
  const source = await load(node), parsed = splitTurns(source)
  return { count: parsed.turns.length, hash: parsed.hashes.at(-1), metaHash: digest(JSON.stringify(source.meta)), recent: source.rows.at(-1)?.row.timestamp ?? source.meta.timestamp, line: parsed.turns.at(-1)?.rows.at(-1)?.lineNumber ?? source.rows[0]?.lineNumber, cutoffAt: parsed.turns.at(-1)?.rows.at(-1)?.row.timestamp ?? source.meta.timestamp }
}

export async function freezeGroup(group, titles) {
  const members = []
  for (const node of group.members) {
    let frozen, error = node.error
    try { frozen = await freezeMember(node) } catch (cause) { error = cause.message }
    const { id, cwd, timestamp, agent_path, agent_role } = node.meta
    members.push({ id: node.id, parent: node.parent, depth: node.depth, paths: node.paths,
      meta: { id, cwd, timestamp, agent_path, agent_role }, title: titles.get(node.id), frozen, error })
  }
  return { root: group.root, members }
}

function spawnedChildren(source) {
  const calls = new Set(), children = new Set()
  for (const { row } of source.rows) {
    const p = row.payload
    if (p.type === 'function_call' && /(?:^|\.)spawn_agent$/.test(p.name ?? '')) calls.add(p.call_id)
    if (p.type !== 'function_call_output' || !calls.has(p.call_id) || typeof p.output !== 'string') continue
    try {
      const output = JSON.parse(p.output)
      const id = output.agent_id ?? output.thread_id
      if (typeof id === 'string' && id) children.add(id)
    } catch { /* Unreadable tool outputs are reported by transcript conversion. */ }
  }
  return children
}

export async function importGroup(ctx, group, options) {
  const handles = new Map(), sources = new Map(), results = [], failures = []
  const settings = node => ({ ...options, title: options.titles.get(node.id), keepOpen: true,
    handle: handles.get(node.id), cwd: options.cwd ?? (node.parent ? handles.get(group.root)?.header.cwd ?? sources.get(group.root)?.meta.cwd : undefined), parentSession: node.parent ? targetId(node.parent) : undefined,
    depth: node.depth, onHandle: handle => handles.set(node.id, handle) })
  try {
    for (const node of group.members) {
      await options.onPhase?.(node.id, '读取源历史')
      try { sources.set(node.id, await load(node)) }
      catch (error) {
        if (error instanceof FrozenSourceError) return { root: group.root, status: '冲突', reason: error.message, results, failures }
        failures.push({ id: node.id, parent: node.parent, phase: '读取源历史', reason: error.message })
      }
    }
    if (!sources.has(group.root)) return { status: '失败', root: group.root, results, failures }
    for (const node of group.members) {
      const source = sources.get(node.id)
      if (!source) continue
      for (const id of spawnedChildren(source)) {
        if (!group.members.some(child => child.parent === node.id && (child.id === id || child.meta.agent_path === id))) {
          failures.push({ id, parent: node.id, reason: '源记录存在创建子agent的结果，但未找到对应子历史' })
        }
      }
    }
    // Own every existing destination before examining any member. No writes
    // happen until the complete group's conflict preflight has succeeded.
    let nativeAdded = false
    for (const node of group.members) {
      if (await ctx.sessionPersistence.stat(targetId(node.id))) {
        const handle = await ctx.sessionPersistence.open(targetId(node.id), options.execute ? 'write' : 'read')
        handles.set(node.id, handle)
        const { events } = await handle.read()
        let importing = false
        for (const event of events) {
          if (event.type === 'codex-migration/begin') importing = true
          else if (event.type === 'codex-migration/checkpoint') importing = false
          else if (event.type === 'turn/start' && !importing) nativeAdded = true
        }
      }
    }
    let sourceAdded = false
    for (const node of group.members) {
      const source = sources.get(node.id)
      if (!source) continue
      const result = await importSession(ctx, source, { ...settings(node), execute: false, previewDetails: options.previewDetails })
      results.push({ source: node.id, parent: node.parent, ...result })
      if (result.status === '冲突') return { root: group.root, status: '冲突', reason: result.reason, results, failures }
      if (!['跳过', '失败'].includes(result.status)) sourceAdded = true
    }
    if (sourceAdded && nativeAdded) return { root: group.root, status: '冲突', reason: 'Codex 与 DSH 组内两边均新增了对话', results, failures }
    if (!options.execute) return { root: group.root, status: sourceAdded ? '待导入' : '跳过', results, failures }
    results.length = 0
    const succeeded = new Set()
    let published = false
    for (const node of group.members) {
      const source = sources.get(node.id)
      if (!source) continue
      if (node.parent && !succeeded.has(node.parent)) {
        failures.push({ id: node.id, parent: node.parent, reason: '父历史未成功迁入' }); continue
      }
      if (options.shouldPause?.()) return { root: group.root, status: '暂停', results, failures, paused: true }
      try {
        const result = await importSession(ctx, source, settings(node))
        results.push({ source: node.id, parent: node.parent, ...result })
        await options.onMember?.(node.id, result)
        if (['成功', '跳过'].includes(result.status) && handles.has(node.id)) succeeded.add(node.id)
        else failures.push({ id: node.id, parent: node.parent, reason: result.reason ?? '无可迁移的完整轮次' })
      } catch (error) { failures.push({ id: node.id, parent: node.parent, phase: '写入成员历史', reason: error.message }) }
    }
    await options.onPhase?.(group.root, '关联父子关系和侧边栏')
    // Publish only children that actually exist. Catalogs are durable native
    // identity, not fabricated tool executions or placeholders for missing data.
    for (const node of group.members) {
      if (!succeeded.has(node.id)) continue
      try {
        const handle = handles.get(node.id), { events } = await handle.read()
        const extras = []
        const provenanceId = 'codex-context-provenance-' + node.id
        if (!events.some(event => event.type === 'user/message' && event.data.id === provenanceId)) extras.push({
          type: 'user/message', surfaceOp: 'append', data: {
            id: provenanceId, role: 'user', source: { kind: 'codex-imported-context', form: 'notice' },
            content: [{ type: 'text', text: 'Codex 历史工具说明：导入的工具调用及结果来自旧 Codex 运行环境，描述历史执行情况。'
              + '当前可用工具和参数以本次请求提供的定义为准；即使名称相同，也不能据旧调用推断当前工具的能力、权限、工作目录或执行状态。' }],
          },
        })
        for (const child of group.members.filter(x => x.parent === node.id && succeeded.has(x.id))) {
          const childId = targetId(child.id)
          if (!events.some(e => e.type === 'subagent/catalog' && e.data.childId === childId)) extras.push({
            type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: handles.get(child.id).header.createdAt,
              mode: 'continuable', label: child.meta.agent_path ?? child.meta.agent_role ?? child.id },
          })
        }
        const missing = failures.filter(f => {
          let current = f.parent
          const seen = new Set()
          while (current && !seen.has(current)) {
            if (current === node.id) return true
            seen.add(current); current = group.members.find(x => x.id === current)?.parent
          }
          return false
        })
        const noticeId = 'codex-context-missing-' + node.id
        const prior = events.findLast(e => e.type === 'user/message' && e.data.id.startsWith(noticeId))
        if (missing.length || prior) {
          const message = missing.length ? 'Codex 迁移缺失说明：' + missing.map(f => '子 agent ' + f.id + ' 历史未迁入：' + f.reason).join('；')
            + '。此历史不可作为已知证据，迁移不会自动补齐。'
            : 'Codex 迁移状态更新：此前提示缺失的子 agent 历史已在本次手动导入中迁入。'
          if (prior?.data.content[0]?.text !== message) {
            extras.push({ type: 'user/message',
              ...(prior ? { surfaceOp: { op: 'replace', startSeq: prior.seq, endSeq: prior.seq }, sourceEventSeqs: [prior.seq] } : { surfaceOp: 'append' }), data: {
              id: noticeId + '-' + events.length, role: 'user', content: [{ type: 'text', text: message }],
              source: { kind: 'codex-imported-context', form: 'notice' },
            } })
          }
        }
        if (extras.length) { await appendMetadata(ctx, handle, extras); published = true }
        if (!node.parent) {
          const { events: updated } = await handle.read()
          refreshImportedSidebar(ctx, handle, updated)
        }
      } catch (error) { failures.push({ id: node.id, parent: node.parent, phase: '发布父子关系及缺失说明', reason: error.message }) }
    }
    return { root: group.root, status: !succeeded.has(group.root) ? '失败' : failures.length ? '部分完成' : sourceAdded || published ? '成功' : '跳过', results, failures }
  } finally { await Promise.allSettled([...handles.values()].map(handle => handle.close())) }
}
