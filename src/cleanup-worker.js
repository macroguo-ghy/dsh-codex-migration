import { DatabaseSync } from 'node:sqlite'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { deleteVerified } from './withdraw.js'
import { atomicJSON } from './tasks.js'

// Entered via execve after DSH shutdown. PID, terminal and supervisor ownership
// survive both replacements, but the old Node runtime and its open files do not.
const [home, path, ...launchArgs] = process.argv.slice(2)
const report = join(home, 'codex-cleanup-status.json')
let requestId
const status = text => atomicJSON(report, { text, requestId })
let lock
try {
  const request = JSON.parse(await readFile(path, 'utf8'))
  requestId = request.requestId
  lock = new DatabaseSync(join(home, 'codex-migration', 'coordination.sqlite'))
  lock.exec('BEGIN EXCLUSIVE')
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
  try {
    lock?.close()
    await rm(path, { force: true })
  } finally {
    try { process.execve(process.execPath, [process.execPath, ...launchArgs], process.env) }
    catch (error) {
      const previous = await readFile(report, 'utf8').then(JSON.parse).catch(() => ({}))
      await status((previous.text ?? '') + ' Web 重启失败，请重新运行 dsh web。')
      throw error
    }
  }
}
