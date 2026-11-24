import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { targetId } from '../src/source.js'
import { deleteVerified, describe, inventory, taskRoots } from '../src/withdraw.js'

test('delete only the confirmed imported family; reject stale or unconfirmed continuation', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-withdraw-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'sessions', 'workspace')
  async function save(source, parent, turns = 0) {
    const id = targetId(source), path = join(root, id)
    await mkdir(path, { recursive: true })
    const rows = [{ type: 'session', version: 4, id, parentSession: parent && targetId(parent) },
      { seq: 0, type: 'codex-migration/begin', ignorable: true, data: { version: 1, source, title: source } },
      { type: 'turn/start' }, { type: 'codex-migration/checkpoint' }]
    for (let i = 0; i < turns; i++) rows.push({ type: 'turn/start' })
    await writeFile(join(path, 'session.v4.jsonl.zstd'), zstdCompressSync(rows.map(r => JSON.stringify(r)).join('\n')))
  }
  await save('parent'); await save('child', 'parent', 1); await save('other')
  await mkdir(join(root, 'native'))
  const selection = async () => [describe((await inventory(home)).groups.find(g => g.root === 'parent'))]
  const before = await selection()
  assert.equal(before[0].members.filter(m => m.continued).length, 1)
  await assert.rejects(deleteVerified(home, { selection: before }), /确认永久删除 DSH 续聊/)
  await save('child', 'parent', 2)
  await assert.rejects(deleteVerified(home, { selection: before, confirmed: true }), /变化/)
  const result = await deleteVerified(home, { selection: await selection(), confirmed: true })
  assert.equal(result.deleted.length, 2)
  assert.deepEqual(result.failures, [])
  assert.deepEqual((await readdir(root)).sort(), ['native', targetId('other')].sort())
  assert.ok(!(await readdir(home)).includes('migration-backups'))
})

test('task selection requires actual successful member writes', () => {
  const groups = ['new', 'increment', 'partial', 'skipped', 'failed'].map(root => ({ root, members: [{ id: root }] }))
  const task = { state: 'completed', groups, checkpoints: { partial: { status: '跳过', wrote: true } },
    results: Object.fromEntries(groups.map(({ root }) => [root, { results: [{ status: ['new', 'increment'].includes(root) ? '成功' : '跳过' }] }])) }
  assert.deepEqual(taskRoots(task), ['new', 'increment', 'partial'])
})

test('withdrawal belongs to the import that preceded it across reimport of the same source', async t => {
  const { taskScope } = await import('../src/withdraw.js')
  const home = await mkdtemp(join(tmpdir(), 'dsh-withdraw-generation-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const dir = join(home, 'codex-migration')
  await mkdir(dir)
  const task = { state: 'completed', createdAt: 1, groups: [{ root: 'r', members: [{ id: 'r' }] }],
    results: { r: { results: [{ source: 'r', status: '成功', reason: '首次导入' }] } } }
  const later = { ...task, createdAt: 3 }
  const store = { dir, list: () => [later, task] }
  const id = targetId('r')
  await writeFile(join(home, 'codex-withdraw-receipt.json'), JSON.stringify({ deleted: [id], deletedAt: { [id]: 2 } }))
  assert.deepEqual(await taskScope(store, task), { current: [], written: ['r'], withdrawn: 1 })
  assert.deepEqual(await taskScope(store, later), { current: ['r'], written: ['r'], withdrawn: 0 })
  await writeFile(join(home, 'codex-withdraw-receipt.json'), JSON.stringify({ deleted: [id], withdrawalDates: { [id]: [4] } }))
  assert.deepEqual(await taskScope(store, task), { current: [], written: ['r'], withdrawn: 0 })
  assert.deepEqual(await taskScope(store, later), { current: [], written: ['r'], withdrawn: 1 })
})
