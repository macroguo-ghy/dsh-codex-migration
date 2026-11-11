import { publishReport } from './host-bridge.js'
import { reportText } from './report.js'
import { fitImportedRequest, importedSession, MAX_DEFAULT_OUTPUT } from './continuation.js'
import { backfillImportedSidebar } from './sidebar.js'
import { parseArgs } from 'node:util'
import { discover } from './source.js'
import { discoverGroups, importGroup } from './groups.js'
import { cleanupCommand } from './cleanup-command.js'
import { pruneBackedUpWorkspaces } from './workspaces.js'

export const name = 'codex-migration'
export const inject = ['commands', 'sessionPersistence']

const usage = '用法：/import-codex [会话ID ... | --all] [--archived] [--execute] [--cwd /绝对路径]'
const safe = value => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()

/** @returns {Promise<{kind: string, text: string, report?: object}>} */
async function runCommand(ctx, rawInput, signal, fallbackCwd, runtime) {
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
  const { paths, titles } = await discover(true)
  const { groups, issues } = await discoverGroups(paths, new Set(positionals), values.archived)
  const output = [], reports = []
  const counts = { '待导入': 0, '成功': 0, '部分完成': 0, '冲突': 0, '跳过': 0, '失败': 0 }
  for (const group of groups) {
    if (signal?.aborted) break
    let result
    try { result = await importGroup(ctx, group, { execute: values.execute, titles, cwd: values.cwd, signal, fallbackCwd, runtime }) }
    catch (error) { result = { root: group.root, status: '失败', reason: error.message, results: [], failures: [] } }
    counts[result.status]++
    reports.push(result)
    output.push(result.status + ' ' + safe(group.root) + (result.reason ? ' · ' + safe(result.reason) : ''))
    for (const member of result.results) output.push('  ' + member.status + ' ' + safe(member.source) + ' ' + safe(member.title)
      + ' → ' + member.id + (member.reason ? ' · ' + safe(member.reason) : '')
      + (member.turns ? ' · 待导入 ' + member.turns + ' 轮' : '')
      + (member.incomplete ? ' · 源末轮尚未结束' : ''),
      ...reportText(member.analysis), ...(member.gaps ?? []).map(gap => '  · ' + safe(gap)),
      ...(member.dependencies ?? []).map(dep => '  外部依赖 ' + safe(dep.name) + ' · ' + dep.status
        + ' · ' + dep.count + ' 条 · 源行 ' + dep.line + ' · ' + dep.evidence),
      ...((member.dependencies ?? []).length ? ['  静态配置比对不代表连接可用，未进行连接探测。'] : []))
    for (const failure of result.failures) output.push('  ' + safe(failure.id) + ' · ' + safe(failure.phase ?? '历史未迁入') + '：' + safe(failure.reason))
  }
  const childCount = groups.reduce((total, group) => total + group.members.length - 1, 0)
    + reports.reduce((total, report) => {
      const members = groups.find(group => group.root === report.root)?.members ?? []
      const missing = report.failures.filter(failure => failure.parent && !members.some(member => member.id === failure.id))
      return total + new Set(missing.map(failure => failure.parent + ':' + failure.id)).size
    }, 0)
  const summary = '共 ' + groups.length + ' 个父会话组，包含 ' + childCount + ' 个子 agent · 待导入 ' + counts['待导入']
    + ' · 冲突 ' + counts['冲突'] + ' · 跳过 ' + counts['跳过']
    + (values.execute ? ' · 成功 ' + counts['成功'] + ' · 部分完成 ' + counts['部分完成'] : '')
    + (counts['失败'] ? ' · 失败 ' + counts['失败'] : '') + (issues.length ? ' · 关系或源异常 ' + issues.length : '')
  for (const issue of issues) output.push('异常 ' + safe(issue.id) + '：' + safe(issue.reason))
  if (signal?.aborted) output.push('已取消。')
  return { kind: 'success', text: [values.execute ? 'Codex 导入结果' : 'Codex 导入预览（只读）',
    summary, ...(output.length ? output : ['没有匹配的会话。'])].join('\n'),
    report: { title: values.execute ? 'Codex 导入结果' : 'Codex 导入预览', summary, groups: reports, issues } }

}

export function apply(ctx) {
  ctx.on('codex-migration/owns-continuation', session => importedSession(session) ? true : undefined)
  ctx.on('codex-migration/default-output-limit', session => importedSession(session) ? MAX_DEFAULT_OUTPUT : undefined)
  const retries = new WeakMap()
  ctx.on('codex-migration/continuation-request', ({ session, request, window, configuration, record }) => {
    if (!importedSession(session)) return
    let step
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      if (session.eventAt(seq).type === 'step/start') { step = seq; break }
    }
    let state = retries.get(session)
    if (!state || state.step !== step) { state = { step, used: false, remaining: 0 }; retries.set(session, state) }
    return fitImportedRequest(ctx.get('tokenMeter'), session, request, window, data => {
      state.remaining = data.retainedPairs
      record(data)
    }, { forceAll: state.used, configuration })
  })
  ctx.on('agent/request-error', ({ agent, failure }, next) => {
    const session = agent.session, state = retries.get(session)
    if (!importedSession(session) || failure.code !== 'CONTEXT_WINDOW_EXCEEDED' || !state || state.used || !state.remaining) return next()
    const last = session.eventAt(session.seq - 1)
    if (last?.data?.stream?.some(chunk => /block|delta|text|reasoning|tool/.test(chunk.type))) return next()
    state.used = true
    return { kind: 'retry' }
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
        const run = workspaceCleanup.then(async () => {
          const { report, ...result } = await runCommand(ctx, invocation.rawInput, invocation.signal,
            invocation.agent.session.header.cwd, invocation.agent.model.current())
          if (report) publishReport(invocation.agent.session, report)
          return result
        })
        active.add(run)
        void run.then(() => active.delete(run), () => active.delete(run))
        return run
      },
    })
  }, 'codex-migration command')
}
