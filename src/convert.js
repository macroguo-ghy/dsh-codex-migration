import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyParts, submissions } from './origin.js'

import { withoutMemoryCitation } from './memory-citation.js'

const text = value => ({ type: 'text', text: value })
const images = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const maxAttachmentBytes = 32 * 1024 * 1024

async function attachment(block, cwd, store) {
  const image = /image/.test(block.type)
  const ref = block.image_url?.url ?? block.image_url ?? block.file_url ?? block.path
  let mediaType = block.media_type ?? block.mime_type
  let name = block.filename ?? block.name
  let data
  if (typeof ref === 'string' && ref.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(ref)
    if (!match || match[2].length > Math.ceil(maxAttachmentBytes / 3) * 4) throw new Error('不支持的数据 URI 或附件过大')
    mediaType = match[1]
    data = Buffer.from(match[2], 'base64')
  } else if (typeof block.file_data === 'string' && /^[A-Za-z0-9+/=]+$/.test(block.file_data)
      && block.file_data.length <= Math.ceil(maxAttachmentBytes / 3) * 4) {
    data = Buffer.from(block.file_data, 'base64')
  } else if (typeof ref === 'string' && (ref.startsWith('file:') || isAbsolute(ref) || cwd && !/^[\w+.-]+:/.test(ref))) {
    const path = ref.startsWith('file:') ? fileURLToPath(ref) : isAbsolute(ref) ? ref : resolve(cwd, ref)
    const fd = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await fd.stat()
      if (!stat.isFile() || stat.size > maxAttachmentBytes) throw new Error('附件不是普通文件或过大')
      const buffer = Buffer.alloc(stat.size)
      const { bytesRead } = await fd.read(buffer, 0, stat.size, 0)
      if (bytesRead !== stat.size) throw new Error('附件在读取时发生变化')
      data = buffer
    } finally { await fd.close() }
    name ??= basename(path)
    const extension = /\.(png|jpe?g|gif|webp)$/i.exec(name)?.[1].toLowerCase()
    if (extension) mediaType ??= 'image/' + (extension === 'jpg' ? 'jpeg' : extension)
  }
  if (!data?.length || data.length > maxAttachmentBytes || !store) throw new Error('附件不可读取或存储不可用')
  if (image) {
    if (!images.has(mediaType)) throw new Error('图像格式不受支持')
    return { type: 'image', attachment: await store.saveImage({ data, mediaType, name }) }
  }
  return { type: 'file', attachment: await store.saveFile({ data, name }) }
}

async function content(value, cwd, store, gaps) {
  if (typeof value === 'string') return [text(value)]
  if (value == null) return []
  if (!Array.isArray(value)) return [text(JSON.stringify(value))]
  const blocks = []
  for (const block of value) {
    if (typeof block?.text === 'string') {
      blocks.push(text(block.text))
      if (block.annotations?.length) gaps.add('部分消息带有 DSH 不支持的 Codex 注释元数据')
    } else if (/image|file/.test(block?.type ?? '')) {
      try {
        blocks.push(await attachment(block, cwd, store))
      } catch {
        const description = [block.type, block.filename ?? block.name ?? block.file_id ?? block.path].filter(Boolean).join(' ')
        gaps.add('附件无法迁移：' + description)
        blocks.push(text('[Codex 附件不可用：' + description + ']'))
      }
    } else {
      gaps.add('不支持的内容块：' + (block?.type ?? '未知'))
      blocks.push(text('[Codex 内容块不可用：' + (block?.type ?? '未知') + ']'))
    }
  }
  return blocks
}

function tokenUsage(value) {
  const { input_tokens: input, output_tokens: output, cached_input_tokens: read = 0,
    cache_write_input_tokens: write = 0, reasoning_output_tokens: reasoning = 0,
    total_tokens: total = input + output } = value ?? {}
  if (![input, output, read, write, reasoning, total].every(n => Number.isSafeInteger(n) && n >= 0) ||
      read + write > input || reasoning > output || total !== input + output) return undefined
  return { inputTokens: input - read - write, outputTokens: output, cacheReadTokens: read,
    cacheWriteTokens: write, reasoningTokens: reasoning, totalTokens: total }
}

export function epoch(value, fallback = 0) {
  const time = typeof value === 'number' ? value : Date.parse(value)
  return Number.isSafeInteger(time) && time >= 0 ? time : fallback
}

export function titleFor(source, title) {
  const evidence = submissions(source.rows)
  let original
  for (const { row } of source.rows) {
    if (row.type !== 'response_item' || row.payload.type !== 'message' || row.payload.role !== 'user') continue
    const userParts = classifyParts(row.payload, evidence).filter(part => part.origin === 'user')
    const candidate = userParts.map(part => part.block.text ?? '').join(' ').trim()
    if (candidate) { original = candidate; break }
  }
  const candidate = title || source.meta.thread_name || original
  const clean = String(candidate ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  let titleText = ''
  let bytes = 0
  for (const character of clean || 'Codex ' + source.meta.id) {
    bytes += Buffer.byteLength(character)
    if (bytes > 80) break
    titleText += character
  }
  return titleText.trimEnd()
}

function agentsSnapshot(row) {
  return row.payload.state?.agents_md ?? row.payload.agents_md
}

function rememberAgents(snapshot, known) {
  if (!snapshot || (typeof snapshot.text !== 'string' && typeof snapshot.path !== 'string')) return false
  const path = snapshot.path ?? ''
  const repeated = known.has(path) && known.get(path) === snapshot.text
  known.set(path, snapshot.text)
  return repeated
}

function compactionSummary(payload) {
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message
  const item = payload.replacement_history?.findLast?.(entry => entry?.type === 'compaction')
  const summary = item?.summary ?? payload.summary
  if (typeof summary === 'string' && summary.trim()) return summary
  if (Array.isArray(summary)) {
    return summary.map(block => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n')
  }
  return ''
}

export async function convertTurns(ctx, source, turns, start, emit, gaps, conversionVersion) {
  const legacy = conversionVersion === 1
  const attributeContext = conversionVersion >= 3
  const contextSource = form => ({ kind: 'codex-imported-context', form })
  const knownAgents = new Map()
  if (!legacy) {
    for (const turn of turns.slice(0, start)) {
      for (const { row } of turn.rows) {
        if (row.type === 'world_state') rememberAgents(agentsSnapshot(row), knownAgents)
      }
    }
  }
  const store = ctx.get('attachments')
  const sourceLines = new Map(source.rows.map((item, index) => [item, item.lineNumber ?? index + 1]))
  for (const [index, item] of turns.slice(start).entries()) {
    const turn = start + index + 1
    const { rows, reason } = item
    const turnContext = rows.find(({ row }) => row.type === 'turn_context')?.row.payload
    const cwd = turnContext?.cwd ?? source.meta.cwd
    const model = turnContext?.model ?? source.meta.model ?? 'codex'
    const base = { turn, step: 1 }
    const pending = new Map()
    const called = new Set()
    let step = false
    let reasoning = []
    /** @type {{data: {usage?: unknown}} | undefined} */
    let latestAssistant
    let usageSnapshot
    let mappedUsage = false
    let aggregateUsage
    const hasUser = rows.some(({ row }) => row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'user')
    const inputEvidence = submissions(rows)
    const add = (type, data, time, extras) => emit(type, data, time, extras)
    const surface = (type, data, time, extras) => add(type, data, time, { surfaceOp: 'append', ...extras })
    const ensureStep = time => {
      if (step) return
      step = true
      add('step/start', base, time)
      if (turn === 1) {
        // The next native DSH turn may replace this protected system surface head.
        surface('system/message', { ...base, message: {
          id: 'codex-system-head', role: 'system', content: [], source: { kind: 'system-prompt' },
        } }, time)
      }
    }
    const assistant = (blocks, time) => {
      ensureStep(time)
      if (conversionVersion >= 5 && reasoning.length && blocks.some(block => block.type === 'tool-call')) {
        const saved = reasoning
        reasoning = []
        assistant(saved, time)
      }
      latestAssistant = surface('assistant/message', { ...base, message: {
        id: 'codex-message-' + turn + '-' + time + '-' + emit.next(), role: 'assistant',
        content: [...reasoning, ...blocks], source: { kind: 'model', provider: 'codex', model },
      }, stream: [] }, time)
      reasoning = []
    }
    const historicalInstruction = (role, blocks, time) => {
      for (const _block of blocks) gaps.note?.('silent-context', '历史上下文：' + role)
      surface('user/message', {
        id: 'codex-context-' + turn + '-' + emit.next(), role: 'user',
        content: [text('[Codex 历史上下文：' + role + ']'), ...blocks],
        source: attributeContext ? contextSource(
          role === '上下文压缩' ? 'notice' : role === 'agent_message' ? 'relay' : 'instructions'
        ) : { kind: 'user' },
      }, time)
    }
    const result = (id, blocks, time, error) => {
      const callSeq = pending.get(id)
      pending.delete(id)
      surface('tool/result', { ...base, message: {
        id: 'codex-result-' + turn + '-' + callSeq, role: 'tool', toolCallId: id,
        content: blocks, source: { kind: 'tool', callId: id }, ...(error ? { isError: true } : {}),
      }, ...(error ? { error } : {}) }, time, { sourceEventSeqs: [callSeq] })
    }
    const initialTime = rows[0]?.row.timestamp
    add('turn/start', { turn }, initialTime)
    if (turn === 1) ensureStep(initialTime)
    for (const [rowIndex, { row }] of rows.entries()) {
      const { type, payload: p, timestamp: time } = row
      gaps.at?.({ line: sourceLines.get(rows[rowIndex]), turn })
      if (type === 'event_msg' && p.type === 'token_count') {
        const usage = tokenUsage(p.info?.last_token_usage)
        if (p.info?.last_token_usage && !usage) gaps.add('部分 Codex token 记录是快照或无法映射为 DSH 用量')
        const snapshot = p.info?.total_token_usage
        const key = snapshot ? JSON.stringify(snapshot) : undefined
        if (usage && latestAssistant && !latestAssistant.data.usage && (key === undefined || key !== usageSnapshot)) {
          latestAssistant.data.usage = usage
          mappedUsage = true
          usageSnapshot = key
        }
        continue
      }
      if (type === 'token_usage_record') {
        aggregateUsage = tokenUsage(p.usage) ?? aggregateUsage
        continue
      }
      if (type === 'compacted') {
        if (p.latest_token_usage_record) {
          aggregateUsage ??= tokenUsage(p.latest_token_usage_record.usage ?? p.latest_token_usage_record)
        }
        if (!legacy) {
          const summary = compactionSummary(p)
          gaps.note?.(summary ? 'compaction-summary' : 'compaction-missing', summary ? '压缩位置及原摘要已保留' : '压缩位置已保留，源未提供可读摘要')
          historicalInstruction('上下文压缩', [text(summary || 'Codex 在此压缩了上下文，原记录未提供可读摘要。')], time)
        }
        continue
      }
      if (type === 'world_state') {
        const agents = agentsSnapshot(row)
        const repeated = !legacy && rememberAgents(agents, knownAgents)
        if (repeated && p.full === true && rows[rowIndex - 1]?.row.type === 'compacted') continue
        const instructions = agents?.text
        if (typeof instructions === 'string' && instructions && !rows.some(({ row: other }) =>
          other.type === 'response_item' && other.payload.content?.some?.(block =>
            typeof block?.text === 'string' && block.text.includes(instructions)))) {
          historicalInstruction('AGENTS.md' + (agents.path ? ' ' + agents.path : ''), [text(instructions)], time)
        } else if (!instructions && typeof agents?.path === 'string') {
          historicalInstruction('AGENTS.md', [text(agents.path)], time)
        }
        continue
      }
      const fallbackUser = type === 'event_msg' && p.type === 'user_message' && !hasUser
      if (!fallbackUser && type !== 'response_item') continue
      if (attributeContext && type === 'response_item' && p.type === 'message' &&
          p.role === 'user' && Array.isArray(p.content)) {
        const groups = []
        for (const [blockIndex, { block, form, origin, evidence }] of classifyParts(p, inputEvidence).entries()) {
          if (form) gaps.note?.('silent-context', '自动上下文：' + origin + '（' + evidence + '）', { block: blockIndex })
          else if (origin === 'unknown') gaps.note?.('unknown-source', '来源证据不足，原文保持可见', { block: blockIndex })
          if (groups.length && groups.at(-1).form === form) groups.at(-1).parts.push(block)
          else groups.push({ form, parts: [block] })
        }
        for (const { form, parts } of groups) {
          const blocks = await content(parts, cwd, store, gaps)
          if (blocks.length) surface('user/message', {
            id: 'codex-user-' + turn + '-' + emit.next(), role: 'user', content: blocks,
            source: form ? contextSource(form) : { kind: 'user' },
          }, time)
        }
        continue
      }
      if (p.type === 'message' || p.type === 'user_message') {
        const raw = p.content ?? p.message
        const value = conversionVersion >= 6 && p.role === 'assistant' && p.phase !== 'commentary' ? withoutMemoryCitation(raw) : raw
        const blocks = value === '' && raw !== value ? [] : await content(value, cwd, store, gaps)
        if (!blocks.length) continue
        if (p.role === 'assistant') assistant(blocks, time)
        else if (p.role === 'user' || fallbackUser) {
          surface('user/message', { id: 'codex-user-' + turn + '-' + emit.next(),
            role: 'user', content: blocks, source: { kind: 'user' } }, time)
        } else if (p.role === 'developer' || p.role === 'system') {
          historicalInstruction(p.role, blocks, time)
        } else gaps.add('不支持的消息角色：' + p.role)
      } else if (p.type === 'reasoning') {
        for (const summary of p.summary ?? []) {
          if (typeof summary.text === 'string' && summary.text) reasoning.push({ type: 'reasoning', text: summary.text })
        }
        if (p.encrypted_content) {
          const readable = (p.summary ?? []).some(block => typeof block.text === 'string' && block.text.trim())
          gaps.note?.(readable ? 'reasoning-summary' : 'reasoning-missing', readable
            ? 'Codex 加密推理不可读取，可读摘要已保留' : 'Codex 加密推理不可读取，源记录没有可读摘要')
          Set.prototype.add.call(gaps, readable ? 'Codex 加密推理不可读取，可读摘要已保留' : 'Codex 加密推理不可读取，源记录没有可读摘要')
        }
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const id = p.call_id
        if (typeof id !== 'string' || !id || called.has(id) || typeof p.name !== 'string' || !p.name) {
          gaps.add('工具调用缺少名称或关联 ID，或关联 ID 重复')
          continue
        }
        called.add(id)
        const args = p.type === 'custom_tool_call' ? JSON.stringify({ input: p.input ?? '' })
          : typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? {})
        assistant([{ type: 'tool-call', id, name: p.name, arguments: args }], time)
        const call = add('tool/call', { ...base, callId: id, name: p.name, arguments: args }, time)
        pending.set(id, call.seq)
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const blocks = await content(p.output, cwd, store, gaps)
        if (pending.has(p.call_id)) result(p.call_id, blocks, time)
        else {
          gaps.add('存在找不到对应调用的工具结果')
          assistant([text('[Codex 未配对工具结果 ' + String(p.call_id) + ']'), ...blocks], time)
        }
      } else if (p.type === 'agent_message') {
        const readable = Array.isArray(p.content) ? p.content.filter(block => typeof block?.text === 'string') : p.content
        if (readable?.length) historicalInstruction('agent_message', await content(readable, cwd, store, gaps), time)
        if (!readable?.length || readable.length < p.content?.length) gaps.add('部分 Codex agent 间消息不可读取')
      } else if (p.type !== 'additional_tools') gaps.add('未映射的 Codex 记录：' + p.type)
    }
    const end = rows.at(-1)?.row.timestamp
    if (reasoning.length) assistant([], end)
    if (latestAssistant && !mappedUsage && aggregateUsage) latestAssistant.data.usage = aggregateUsage
    for (const id of pending.keys()) {
      gaps.add('工具调用没有记录结果：' + id)
      result(id, [text('[Codex 未记录工具结果]')], end,
        { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN', message: 'Codex did not record a tool result' })
    }
    if (step) add('step/end', base, end)
    add('turn/end', { turn, reason: reason === 'aborted' ? { kind: 'aborted', reason: { kind: 'user' } } : { kind: reason } }, end)
  }
}
