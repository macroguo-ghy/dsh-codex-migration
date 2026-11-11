import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { promisify } from 'node:util'
import { moveSessions, scan } from './cleanup.js'

const exec = promisify(execFile)
const [pidText, home, service, expected] = process.argv.slice(2)
const pid = Number(pidText)
const launchers = join(homedir(), '.local', 'bin')
const options = { timeout: 30_000, env: { ...process.env, DSH_HOME: home } }
const status = text => writeFile(join(home, 'codex-cleanup-status.json'), JSON.stringify({ text }), { mode: 0o600 })
let stopped = false
try {
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
  const { candidates } = await scan(join(home, 'sessions'))
  if (candidates.length !== Number(expected)) throw new Error('导入会话数量在执行前发生变化，清理取消。')
  const { moved, backup, failures } = await moveSessions(home, candidates)
  await status('已移出 ' + moved + ' / ' + expected + ' 条。备份目录：' + backup
    + (failures.length ? '\n移动失败：' + failures.join('\n') : ''))
} catch (error) {
  await status('清理未完成。' + error.message)
} finally {
  if (stopped) {
    try { await exec(join(launchers, 'dsh-start'), [], options) }
    catch { await status('Web 重启失败。请手动运行 dsh-start，已移动的会话可在 migration-backups 下查找。') }
  }
}
