import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harness, turn, lines } from './harness.mjs'

test('native package exposes migration RPC without creating a chat; frozen import and member resume survive restart', async t => {
  const h = await harness(t)
  const path = await h.source('web-root', turn('root'))
  await h.source('web-child', turn('child'), { parent: 'web-root', archived: true })
  const first = await h.run({ migration: { inspectDetail: true, pauseDuringWrite: true, append: { path, lines: lines(turn('after preview')) } } })
  assert.equal(first.migration.preview.total, 1)
  assert.equal(first.migration.preview.rows[0].children, 1)
  assert.deepEqual(first.migration.detail.messages.map(message => message.text), ['root', 'answer: root'])
  assert.equal(first.migration.detail.members.length, 2)
  assert.ok(first.migration.detail.result.results.every(member => member.analysis))
  assert.equal(first.migration.detail.result.results.length, 2)
  assert.deepEqual(first.migration.agents, [])
  const paused = first.migration.task
  assert.equal(paused.state, 'paused')
  assert.equal(Object.keys(paused.checkpoints).length, 1)
  assert.equal(first.sessions[0].events.filter(e => e.type === 'user/message' && e.data.source?.kind !== 'codex-imported-context').length, 1)
  const resumed = await h.run({ migration: { resume: paused.id, withdrawPreview: true } })
  assert.equal(resumed.migration.task.state, 'completed')
  assert.equal(resumed.migration.task.results['web-root'].status, '成功')
  assert.equal(resumed.migration.withdrawal.rows.length, 1)
  assert.equal(resumed.migration.withdrawal.rows[0].members.length, 2)
  assert.equal(resumed.sessions.length, 2)
  const parent = resumed.sessions.find(session => !session.header.parentSession)
  assert.equal(parent.events.filter(e => e.type === 'subagent/catalog').length, 1)
  assert.equal(parent.events.filter(e => e.type === 'turn/start').length, 1)
  assert.ok(resumed.workspaces.some(workspace => workspace.sessions.includes(parent.header.id)))
})


test('actual host kill after durable transcript write resumes without duplicate turns and completes workspace publication', async t => {
  const h = await harness(t)
  await h.source('crash-root', turn('do not duplicate'))
  await assert.rejects(h.run({ migration: { crashAfterWrite: true } }))
  const dir = join(h.env.DSH_HOME, 'codex-migration')
  const name = (await readdir(dir)).find(name => name.startsWith('task-') && name.endsWith('.json'))
  const task = JSON.parse(await readFile(join(dir, name), 'utf8'))
  assert.equal(task.state, 'running')
  const resumed = await h.run({ migration: { resume: task.id } })
  assert.equal(resumed.migration.before.state, 'interrupted')
  assert.equal(resumed.migration.task.state, 'completed')
  assert.equal(resumed.sessions.length, 1)
  assert.equal(resumed.sessions[0].events.filter(event => event.type === 'turn/start').length, 1)
  assert.ok(resumed.workspaces.some(workspace => workspace.sessions.includes(resumed.sessions[0].header.id)))
})

test('missing working directory blocks only that group, while other groups complete', async t => {
  const h = await harness(t)
  const path = await h.source('missing-directory', turn('missing directory'))
  const source = (await readFile(path, 'utf8')).split('\n')
  const meta = JSON.parse(source[0]); meta.payload.cwd = '/not/a/real/directory/migration'
  source[0] = JSON.stringify(meta); await writeFile(path, source.join('\n'))
  await h.source('good-directory', turn('valid directory'))
  const result = await h.run({ migration: {} })
  assert.equal(result.migration.preview.counts.cwd, 1)
  assert.equal(result.migration.task.results['good-directory'].status, '成功')
  assert.match(result.migration.task.results['missing-directory'].reason, /工作目录/)
  assert.equal(result.sessions.length, 1)
})


test('ending a paused task releases its unfinished group for a new task without duplicating the completed parent', async t => {
  const h = await harness(t)
  await h.source('end-root', turn('parent must remain once'))
  await h.source('end-child', turn('child after ending'), { parent: 'end-root' })
  const result = await h.run({ migration: { pauseDuringWrite: true, endPaused: true } })
  assert.equal(result.migration.ended.state, 'ended')
  assert.notEqual(result.migration.ended.id, result.migration.task.id)
  assert.equal(result.migration.task.results['end-root'].status, '成功')
  assert.equal(result.sessions.length, 2)
  assert.ok(result.sessions.every(session => session.events.filter(event => event.type === 'turn/start').length === 1))
})


test('an interrupted slash command can continue as the same durable Web task', async t => {
  const h = await harness(t)
  await h.source('command-root', turn('command parent'))
  await h.source('command-child', turn('command child'), { parent: 'command-root' })
  const first = await h.run({ command: '/import-codex command-root --execute', commandPauseDuringWrite: true })
  const task = first.commandTasks[0]
  assert.equal(task.state, 'paused')
  assert.equal(task.groups[0].members.length, 2)
  const resumed = await h.run({ migration: { resume: task.id } })
  assert.equal(resumed.migration.task.results['command-root'].status, '成功')
  assert.equal(resumed.sessions.length, 2)
  assert.ok(resumed.sessions.every(session => session.events.filter(e => e.type === 'turn/start').length === 1))
})


test('changing a reviewed child prefix blocks its entire family before any destination write', async t => {
  const h = await harness(t)
  await h.source('frozen-family', turn('parent unchanged'))
  const path = await h.source('frozen-child', turn('old child'), { parent: 'frozen-family' })
  const changed = (await readFile(path, 'utf8')).replaceAll('old child', 'rewritten child')
  await h.source('independent-family', turn('independent allowed'))
  const result = await h.run({ migration: { rewrite: { path, lines: changed } } })
  assert.equal(result.migration.task.results['frozen-family'].status, '冲突')
  assert.equal(result.migration.task.results['independent-family'].status, '成功')
  assert.equal(result.sessions.length, 1)
  assert.equal(result.migration.preview.rows.find(row => row.root === 'frozen-family').members[1].cutoff.turns, 1)
  assert.ok(result.migration.preview.rows.find(row => row.root === 'frozen-family').members[1].cutoff.line > 1)
})

test('standard web launch withdraws offline and resumes with the same process identity', {
  skip: !process.execve || !['darwin', 'linux'].includes(process.platform),
}, async t => {
  const h = await harness(t)
  await h.source('remove', turn('withdraw this synthetic conversation'))
  await h.source('keep', turn('keep this synthetic conversation'))
  const result = await h.run({ migration: { withdrawRoot: 'remove' }, timeout: 40000 })
  assert.ok(result.beforePid > 0)
  assert.equal(result.afterPid, result.beforePid)
  assert.equal(result.receipt.requestId, 'withdraw-probe')
  assert.match(result.receipt.text, /已撤回 1 个对话/)
  assert.equal(result.sessions.length, 1)
  assert.ok(result.sessions[0].events.some(event => event.type === 'codex-migration/begin' && event.data.source === 'keep'))
})
