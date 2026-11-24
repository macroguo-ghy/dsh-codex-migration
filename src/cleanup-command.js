import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { describe, inventory, selectVerified, taskScope } from './withdraw.js'
import { atomicJSON } from './tasks.js'

function supportsWebRestart() {
  const args = process.argv.slice(2)
  return typeof process.execve === 'function' && ['linux', 'darwin'].includes(process.platform) &&
    (args[0] === 'web' || (args[0] === '--profile' && args[1] === 'web') || args[0] === '--profile=web')
}
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
  return { rows, canRestart: supportsWebRestart(), skipped: skipped.length, previous: previous?.text, previousId: previous?.requestId }
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
    if (!supportsWebRestart()) throw new Error('实验性撤回需要支持进程替换的 Node.js 和以 dsh web 或 dsh --profile web 启动的 macOS/Linux 宿主。')
    const worker = fileURLToPath(new URL('./cleanup-worker.js', import.meta.url))
    await access(worker)
    const busy = () => ctx.get('agents')?.list().some(agent => agent.status !== 'idle') || importing()
    if (busy()) {
      throw new Error('DSH 仍有活跃会话，请等它们空闲后再执行。')
    }
    if (input.requestId !== undefined && typeof input.requestId !== 'string') throw new Error('无效撤回请求 ID。')
    const path = join(home, 'codex-delete-' + randomUUID() + '.json')
    await atomicJSON(path, {
      requestId: input.requestId, selection: input.selection.map(({ root, scope }) => ({ root, scope })), confirmed: input.confirmed === true, taskId: input.taskId,
    })
    try {
      await atomicJSON(report, { requestId: input.requestId, text: '已提交永久删除，正在等待 Web 重启。' })
    } catch (error) { await rm(path, { force: true }); throw error }
    // Let the gateway deliver the response before asking DSH to drain and exit.
    setTimeout(() => {
      if (busy()) {
        pending = false
        rmSync(path, { force: true })
        writeFileSync(report, JSON.stringify({ requestId: input.requestId, text: '撤回已取消。DSH 开始了新的任务，请等它结束后重试。' }), { mode: 0o600 })
        return
      }
      process.once('exit', code => {
        try {
          if (code !== 0) throw new Error('Web 未正常关闭，已取消撤回。')
          process.execve(process.execPath, [process.execPath, worker, home, path, ...process.execArgv, ...process.argv.slice(1)], process.env)
        } catch (error) {
          rmSync(path, { force: true })
          writeFileSync(report, JSON.stringify({ requestId: input.requestId, text: '撤回未执行。' + error.message + ' 请重新运行 dsh web。' }), { mode: 0o600 })
        }
      })
      process.kill(process.pid, 'SIGTERM')
    }, 1200)
    return { submitted: true }
  } catch (error) { pending = false; throw error }
}
