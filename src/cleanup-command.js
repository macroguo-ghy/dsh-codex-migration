import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { scan } from './cleanup.js'

const exec = promisify(execFile)
const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const report = join(home, 'codex-cleanup-status.json')
const help = '用法：/cleanup-codex [--execute]。默认预览。执行会短暂重启 DSH Web，并把迁移会话移到备份。'
let pending = false

export async function cleanupCommand(ctx, invocation, importing) {
  const args = invocation.rawInput.trim()
  if (args === '--help') return { kind: 'success', text: help }
  if (args && args !== '--execute') return { kind: 'error', text: help }
  const previous = await readFile(report, 'utf8').then(JSON.parse).catch(() => undefined)
  const { candidates, unverified } = await scan(join(home, 'sessions'))
  const summary = ['已核验的导入会话：' + candidates.length + ' 条',
    ...(unverified.length ? ['无法核验，保留：' + unverified.length + ' 条'] : []),
    ...(previous?.text ? ['上次清理：' + previous.text] : [])].join('\n')
  if (!args || !candidates.length) return { kind: 'success', text: summary + '\n' + help }
  if (pending || importing()) return { kind: 'error', text: '正在导入或清理，请稍后再试。' }
  pending = true
  try {
    const service = 'gui/' + process.getuid?.() + '/org.deepseek.dsh-web'
    const launchers = join(homedir(), '.local', 'bin')
    const start = join(launchers, 'dsh-start')
    const stop = join(launchers, 'dsh-stop')
    if (process.platform !== 'darwin' || process.argv.length !== 3 || process.argv[2] !== 'web') {
      throw new Error('当前启动方式不支持对话框执行清理，请使用离线清理命令。')
    }
    await Promise.all([access(start), access(stop)])
    const { stdout } = await exec('/bin/launchctl', ['print', service])
    if (Number(stdout.match(/^\s*pid = (\d+)/m)?.[1]) !== process.pid) {
      throw new Error('当前进程不是 dsh-start 管理的 Web 服务，请使用离线清理命令。')
    }
    if (ctx.get('agents')?.list().some(agent => agent.status !== 'idle') || importing()) {
      throw new Error('DSH 仍有活跃会话，请等它们空闲后再执行。')
    }
    await writeFile(report, JSON.stringify({ text: '已提交，正在等待 Web 重启。' }), { mode: 0o600 })
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./cleanup-worker.js', import.meta.url)),
      String(process.pid), home, service, String(candidates.length)], {
      detached: true, stdio: 'ignore', env: process.env,
    })
    await once(worker, 'spawn')
    worker.unref()
    return { kind: 'success', text: '已提交清理 ' + candidates.length + ' 条导入会话。Web 将短暂重启。恢复后运行 /cleanup-codex 查看结果。' }
  } catch (error) {
    pending = false
    return { kind: 'error', text: error.message }
  }
}
