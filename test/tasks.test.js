import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../src/tasks.js'

test('durable tasks reject concurrent/overlapping work, recover interruption and release ended reservations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'migration-tasks-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const store = await TaskStore.open(dir)
  const task = await store.create({ sourceRoot: '/source', groups: [{ root: 'one' }, { root: 'two' }] })
  await assert.rejects(store.create({ groups: [{ root: 'other' }] }), /正在执行/)
  await store.update(task, { state: 'paused' })
  await assert.rejects(store.create({ groups: [{ root: 'one' }] }), /继续原任务/)
  const other = await store.create({ groups: [{ root: 'other' }] })
  await store.close()
  const recovered = await TaskStore.open(dir)
  assert.equal(recovered.get(other.id).state, 'interrupted')
  assert.equal(recovered.get(task.id).sourceRoot, '/source')
  await recovered.update(recovered.get(task.id), { state: 'ended' })
  await recovered.create({ groups: [{ root: 'one' }] })
  await recovered.close()
})

test('two processes racing after an actual owner crash admit only one replacement', async t => {
  const { spawn } = await import('node:child_process')
  const { once } = await import('node:events')
  const dir = await mkdtemp(join(tmpdir(), 'migration-lease-'))
  const children = []
  t.after(async () => { for (const child of children) child.kill('SIGKILL'); await rm(dir, { recursive: true, force: true }) })
  const script = `import { TaskStore } from ${JSON.stringify(new URL('../src/tasks.js', import.meta.url).href)};
    try { await TaskStore.open(process.argv[1]); console.log('READY'); process.stdin.resume() }
    catch (error) { console.log(error.message.includes('已有迁移服务') ? 'BUSY' : 'ERROR:' + error.message) }`
  const start = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['pipe', 'pipe', 'pipe'] })
    children.push(child); let text = ''
    child.stdout.on('data', data => { text += data; if (text.includes('\n')) resolve({ child, status: text.trim() }) })
    child.on('error', reject)
  })
  const owner = await start(); assert.equal(owner.status, 'READY')
  const exited = once(owner.child, 'exit'); owner.child.kill('SIGKILL'); await exited
  const replacements = await Promise.all([start(), start()])
  assert.deepEqual(replacements.map(item => item.status).sort(), ['BUSY', 'READY'])
})
