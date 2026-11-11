import { fitImportedRequest, importedSession, MAX_DEFAULT_OUTPUT } from './continuation.js'
import { backfillImportedSidebar } from './sidebar.js'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'
import { discover, readRollout, rolloutId } from './source.js'
import { importSession } from './import.js'
import { cleanupCommand } from './cleanup-command.js'
import { pruneBackedUpWorkspaces } from './workspaces.js'

export const name = 'codex-migration'
export const inject = ['commands', 'sessionPersistence']

const usage = '用法：/import-codex [会话ID ... | --all] [--archived] [--execute] [--cwd /绝对路径]'
const safe = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()

async function runCommand(ctx, rawInput, signal, fallbackCwd) {
  const args = rawInput.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  let values, positionals
  try {
    ({ values, positionals } = parseArgs({
      args: args.map(word => word.replace(/^(['"])(.*)\1$/, '$2')),
      allowPositionals: true,
      options: { all: { type: 'boolean' }, archived: { type: 'boolean' }, execute: { type: 'boolean' },
        cwd: { type: 'string' }, help: { type: 'boolean' } },
    }))
  } catch (error) {
    return { kind: 'error', text: usage + '\n' + error.message }
  }
  if (values.help) return { kind: 'success', text: usage }
  if (values.all && positionals.length || values.execute && !values.all && !positionals.length) {
    return { kind: 'error', text: usage + '\n执行导入需明确指定 ID 或 --all。' }
  }
  const { paths, titles } = await discover(values.archived)
  const selected = new Set(positionals)
  const found = new Set()
  const candidates = new Map()
  const output = []
  const counts = { pending: 0, conflict: 0, skipped: 0, failed: 0 }
  function report(status, detail) {
    if (status === '冲突') counts.conflict++
    else if (status === '跳过') counts.skipped++
    else if (status === '失败') counts.failed++
    else if (!values.execute) counts.pending++
    output.push(status + ' ' + detail)
  }
  for (const path of paths) {
    if (signal?.aborted) break
    const filename = basename(path)
    try {
      const id = await rolloutId(path)
      if (selected.size && !selected.has(id)) continue
      if (!candidates.has(id)) candidates.set(id, [])
      candidates.get(id).push(path)
      found.add(id)
    } catch (error) {
      if (!selected.size || [...selected].some(id => filename.endsWith('-' + id + '.jsonl'))) {
        report('失败', safe(filename) + '：' + safe(error.message))
      }
    }
  }
  for (const [id, locations] of candidates) {
    if (signal?.aborted) break
    try {
      let source
      let conflicting = false
      for (const path of locations) {
        const copy = await readRollout(path)
        if (copy.meta.id !== id) throw new Error('扫描后源会话 ID 发生变化')
        if (source) {
          if (copy.rows.every((item, i) => item.line === source.rows[i]?.line)) continue
          if (!source.rows.every((item, i) => item.line === copy.rows[i]?.line)) {
            conflicting = true
            break
          }
        }
        source = copy
      }
      if (conflicting) {
        report('冲突', safe(id) + '：同一源会话 ID 有不同的历史文件')
        continue
      }
      const result = await importSession(ctx, source, { title: titles.get(id), cwd: values.cwd,
        execute: values.execute, signal, fallbackCwd })
      report(result.status, [safe(id), safe(result.title), '→', result.id,
        result.reason ? '· ' + safe(result.reason) : '',
        result.turns ? '· 待导入 ' + result.turns + ' 轮' : '',
        result.incomplete ? '· 源末轮尚未结束' : '',
        ...((result.gaps ?? []).map(gap => '· ' + safe(gap)))].filter(Boolean).join(' '))
    } catch (error) {
      report('失败', safe(id) + '：' + safe(error.message))
    }
  }
  for (const id of selected) if (!found.has(id)) report('失败', safe(id) + '：未找到源会话')
  const total = output.length
  const summary = '共 ' + total + ' 条 · 待导入 ' + counts.pending + ' · 冲突 ' + counts.conflict
    + ' · 跳过 ' + counts.skipped + (counts.failed ? ' · 失败 ' + counts.failed : '')
  if (signal?.aborted) output.push('已取消。')
  return { kind: 'success', text: [values.execute ? 'Codex 导入结果' : 'Codex 导入预览（只读）',
    ...(!values.execute ? [summary, '范围：自动导入消息、工具轨迹、可读推理摘要、元数据及支持的附件。'] : []),
    ...(output.length ? output : ['没有匹配的会话。'])].join('\n') }
}

export function apply(ctx) {
  ctx.on('codex-migration/owns-continuation', session => importedSession(session) ? true : undefined)
  ctx.on('codex-migration/default-output-limit', session => importedSession(session) ? MAX_DEFAULT_OUTPUT : undefined)
  ctx.on('codex-migration/continuation-request', ({ session, request, window, record }) => {
    if (importedSession(session)) return fitImportedRequest(ctx.get('tokenMeter'), session, request, window, record)
  })
  const active = new Set()
  const workspaceCleanup = ctx.loader.await().then(() => pruneBackedUpWorkspaces(ctx)).catch(error => {
    ctx.logger.warn('codex-migration: ' + error.message)
  })
  void ctx.loader.await().then(() => backfillImportedSidebar(ctx)).catch(error => {
    ctx.logger.warn('codex-migration: ' + error.message)
  })
  ctx.effect(function* () {
    yield () => Promise.allSettled(active)
    yield ctx.commands.register({
      definitionId: 'dsh-codex-migration/cleanup',
      name: 'cleanup-codex',
      description: 'Preview or back up imported Codex conversations',
      input: { hint: '[--execute，执行会重启 DSH Web]' },
      async handler(invocation) {
        await workspaceCleanup
        return cleanupCommand(ctx, invocation, () => active.size > 0)
      },
    })
    yield ctx.commands.register({
      definitionId: 'dsh-codex-migration/import',
      name: 'import-codex',
      description: 'Preview or import Codex conversations',
      input: { hint: '[会话 ID … | --all] [--archived] [--execute] [--cwd 路径]' },
      handler(invocation) {
        const run = workspaceCleanup.then(() => runCommand(ctx, invocation.rawInput, invocation.signal, invocation.agent.session.header.cwd))
        active.add(run)
        void run.then(() => active.delete(run), () => active.delete(run))
        return run
      },
    })
  }, 'codex-migration command')
}
