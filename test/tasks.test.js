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

test('legacy snapshot and incremental receipts recover after a process kill without rewriting the manifest', async t => {
  const { spawnSync } = await import('node:child_process')
  const { readFile, writeFile } = await import('node:fs/promises')
  const { DatabaseSync } = await import('node:sqlite')
  const dir = await mkdtemp(join(tmpdir(), 'migration-progress-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const id = 'task-ab01', path = join(dir, id + '.json')
  const legacy = { id, state: 'paused', createdAt: 1, updatedAt: 1, groups: [{ root: 'a' }, { root: 'b' }],
    results: { a: { status: '成功' } }, checkpoints: { a: { wrote: true } } }
  const encoded = JSON.stringify(legacy)
  await writeFile(path, encoded)
  const code = `import { TaskStore } from ${JSON.stringify(new URL('../src/tasks.js', import.meta.url).href)};
    const store = await TaskStore.open(process.argv[1]), task = store.get('task-ab01');
    await store.resume(task);
    for (let i = 0; i < 50; i++) store.progress(task, 'b', 'child', '写入历史');
    await store.update(task, { checkpoints: { child: { wrote: true } } });
    await store.update(task, { results: { b: { status: '成功' } } });
    process.kill(process.pid, 'SIGKILL');`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, dir])
  assert.equal(child.signal, 'SIGKILL', child.stderr.toString())
  assert.equal(await readFile(path, 'utf8'), encoded)

  const store = await TaskStore.open(dir), recovered = store.get(id)
  assert.equal(recovered.state, 'interrupted')
  assert.deepEqual(recovered.checkpoints, { a: { wrote: true }, child: { wrote: true } })
  assert.deepEqual(recovered.results, { a: { status: '成功' }, b: { status: '成功' } })
  await store.resume(recovered)
  await store.settle(recovered)
  await store.close()
  const terminal = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(terminal, recovered)

  // A committed terminal snapshot can coexist with a stale journal if the host
  // dies before cleanup. Offline withdrawal may already have updated the snapshot.
  const db = new DatabaseSync(join(dir, 'task-progress.sqlite'))
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM changes').get().count, 0)
  db.prepare('INSERT INTO changes(task, patch) VALUES (?, ?)').run(id, JSON.stringify({ state: 'running' }))
  db.close()
  terminal.withdrawals = [{ text: '已完成撤回' }]
  await writeFile(path, JSON.stringify(terminal))
  const again = await TaskStore.open(dir)
  assert.deepEqual(again.get(id), terminal)
  await again.close()
})
