import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { deleteVerified } from './withdraw.js'
import { atomicJSON } from './tasks.js'

const exec = promisify(execFile)
const [pidText, home, service] = process.argv.slice(2)
const pid = Number(pidText)
const launchers = join(homedir(), '.local', 'bin')
const options = { timeout: 30_000, env: { ...process.env, DSH_HOME: home } }
let requestId
const status = text => writeFile(join(home, 'codex-cleanup-status.json'), JSON.stringify({ text, requestId }), { mode: 0o600 })
let stopped = false
try {
  const request = JSON.parse(await readFile(join(home, 'codex-delete-request.json'), 'utf8'))
  requestId = request.requestId
  await setTimeout(1200)
  const { stdout } = await exec('/bin/launchctl', ['print', service], options)
  if (Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]) !== pid) throw new Error('Web 进程已更换，清理取消。')
  await exec(join(launchers, 'dsh-stop'), [], options)
  stopped = true
  let exited = false
  for (let attempt = 0; attempt < 40; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code !== 'ESRCH') throw error
      exited = true
      break
    }
    await setTimeout(250)
  }
  if (!exited) throw new Error('旧 Web 进程尚未退出，清理取消。')

  const { deleted, failures } = await deleteVerified(home, request)
  const text = '已撤回 ' + (request.selection.length - failures.length) + ' 个对话。' + (failures.length ? '另有 ' + failures.length + ' 个对话未完整撤回，请重新预览。' : '')
  await status(text)
  if (request.taskId && /^task-[a-f0-9-]+$/.test(request.taskId)) {
    const path = join(home, 'codex-migration', request.taskId + '.json')
    const task = JSON.parse(await readFile(path, 'utf8'))
    await atomicJSON(path, { ...task, withdrawals: [...(task.withdrawals ?? []), { at: Date.now(), text, deleted }] })
  }
} catch (error) {
  await status('清理未完成。' + error.message)
} finally {
  await rm(join(home, 'codex-delete-request.json'), { force: true }).catch(() => {})
  if (stopped) {
    try { await exec(join(launchers, 'dsh-start'), [], options) }
    catch { await status((await readFile(join(home, 'codex-cleanup-status.json'), 'utf8').then(JSON.parse)).text + ' Web 重启失败，请手动运行 dsh-start。') }
  }
}
