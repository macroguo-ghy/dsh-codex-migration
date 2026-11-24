import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, inventory, selectVerified, taskScope } from './withdraw.js'
import { atomicJSON } from './tasks.js'

const exec = promisify(execFile)
const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const report = join(home, 'codex-cleanup-status.json')
let pending = false
export const cleanupPending = () => pending

export async function previewCleanup(service, input) {
  const { groups, skipped } = await inventory(home)
  const previous = await readFile(report, 'utf8').then(JSON.parse).catch(() => undefined)
  const task = input.taskId && service.store.get(input.taskId)
  let roots
  if (task) roots = (await taskScope(service.store, task)).current
  else if (input.root) roots = [input.root]
  const rows = groups.filter(g => !roots || roots.includes(g.root)).map(describe)
  if (task) for (const row of rows) {
    const writes = task.results[row.root]?.results?.filter(member => member.status === '成功') ?? []
    row.taskEffect = writes.some(member => /增量导入|恢复导入/.test(member.reason ?? ''))
      ? '该任务追加过历史，永久删除包含任务之前的内容。'
      : writes.length && writes.every(member => member.reason?.startsWith('首次导入')) ? '该任务有首次导入记录。' : '该任务有已写入的会话记录。'
  }
  return { rows, skipped: skipped.length, previous: previous?.text, previousId: previous?.requestId }
}

export async function cleanupCommand(invocation) {
  const hint = '请在 Codex 迁移页面预览并确认永久删除；可从会话详情或任务记录进入。'
  if (invocation.rawInput.trim()) return { kind: 'error', text: '不支持通过斜杠命令执行永久删除。' + hint }
  const { groups } = await inventory(home)
  return { kind: 'success', text: '已核验的导入会话：' + groups.reduce((n, g) => n + g.members.length, 0) + ' 条。' + hint }
}

export async function executeCleanup(ctx, serviceStore, input, importing) {
  const { groups } = await inventory(home)
  const selected = selectVerified(groups, input.selection, input.confirmed)
  const allowed = input.taskId ? (await taskScope(serviceStore.store, serviceStore.store.get(input.taskId))).current : input.root ? [input.root] : null
  if (allowed && selected.some(g => !allowed.includes(g.root))) throw new Error('选择超出当前撤回范围。')
  if (pending || importing()) throw new Error('正在导入或撤回，请稍后再试。')
  pending = true
  try {
    const service = 'gui/' + process.getuid?.() + '/org.deepseek.dsh-web'
    const launchers = join(homedir(), '.local', 'bin')
    const start = join(launchers, 'dsh-start')
    const stop = join(launchers, 'dsh-stop')
    if (process.platform !== 'darwin' || process.argv.length !== 3 || process.argv[2] !== 'web') {
      throw new Error('当前启动方式不支持对话框执行清理，请使用默认 dsh-start 启动方式。')
    }
    await Promise.all([access(start), access(stop)])
    const { stdout } = await exec('/bin/launchctl', ['print', service])
    if (Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]) !== process.pid) {
      throw new Error('当前进程不是 dsh-start 管理的 Web 服务，请使用默认 dsh-start 启动方式。')
    }
    if (ctx.get('agents')?.list().some(agent => agent.status !== 'idle') || importing()) {
      throw new Error('DSH 仍有活跃会话，请等它们空闲后再执行。')
    }
    await atomicJSON(join(home, 'codex-delete-request.json'), {
      requestId: input.requestId, selection: input.selection.map(({ root, scope }) => ({ root, scope })), confirmed: input.confirmed === true, taskId: input.taskId,
    })
    await writeFile(report, JSON.stringify({ requestId: input.requestId, text: '已提交永久删除，正在等待 Web 重启。' }), { mode: 0o600 })
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./cleanup-worker.js', import.meta.url)),
      String(process.pid), home, service], { detached: true, stdio: 'ignore', env: process.env })
    worker.once('exit', () => { pending = false })
    await once(worker, 'spawn')
    worker.unref()
    return { submitted: true }
  } catch (error) { pending = false; throw error }
}
