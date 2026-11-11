import assert from 'node:assert/strict'
import { appendFile } from 'node:fs/promises'
import { test } from 'node:test'
import { harness, row, turn } from './harness.mjs'
import { targetId } from '../src/source.js'

test('parent import restores archived descendants as native subagents and reports missing history to its model', { timeout: 100_000 }, async t => {
  const h = await harness(t)
  const parentRows = turn('parent original')
  parentRows.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'spawn-missing', arguments: '{"task_name":"missing"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'spawn-missing', output: '{"agent_id":"missing-child"}' }))
  await h.source('parent', parentRows)
  await h.source('child', turn('child original'), { parent: 'parent', archived: true })
  await h.source('grandchild', turn('grandchild original'), { parent: 'child' })
  const broken = await h.source('broken-child', [], { parent: 'parent' })
  await appendFile(broken, '{broken}\n')
  const preview = await h.run({ command: '/import-codex parent' })
  assert.match(preview.result.text, /共 1 个父会话组.*4 个子 agent/)
  assert.deepEqual(preview.sessions, [])
  const imported = await h.run({ command: '/import-codex parent --execute', catalogs: [targetId('parent'), targetId('child')],
    addresses: [{ kind: 'subagent', parentSessionId: targetId('parent'), childSessionId: targetId('child'), mode: 'continuable' }] })
  assert.match(imported.result.text, /部分完成 parent/)
  const parent = imported.sessions.find(x => x.header.id === targetId('parent'))
  const child = imported.sessions.find(x => x.header.id === targetId('child'))
  const grandchild = imported.sessions.find(x => x.header.id === targetId('grandchild'))
  assert.equal(child.header.origin, 'subagent'); assert.equal(child.header.parentSession, parent.header.id)
  assert.equal(grandchild.header.parentSession, child.header.id); assert.equal(grandchild.header.delegationDepth, 2)
  assert.equal(child.events.find(x => x.type === 'subagent/descriptor').data.mode, 'continuable')
  assert.equal(imported.catalogs[0][0].id, child.header.id)
  assert.equal(imported.catalogs[1][0].id, grandchild.header.id)
  assert.ok(JSON.stringify(imported.pages).includes('child original'))
  await appendFile(await h.source('child', [...turn('child original'), ...turn('child added')], { parent: 'parent', archived: true }), '')
  const increment = await h.run({ command: '/import-codex parent --execute' })
  assert.match(increment.result.text, /增量导入 1 轮/)
  assert.ok(JSON.stringify(increment.sessions).includes('child added'))
  const continued = await h.run({ resume: parent.header.id, childTask: child.header.id })
  assert.ok(continued.requests.some(request => JSON.stringify(request).includes('continue child fixture') && JSON.stringify(request).includes('child original')))
  assert.match(JSON.stringify(continued.requests), /broken-child.*未迁入/)
  assert.match(JSON.stringify(continued.requests), /子 agent missing-child 历史未迁入/)
  assert.ok(!JSON.stringify(continued.requests[0]).includes('child original'))
  const more = await h.source('new-child', turn('new child original'), { parent: 'parent' })
  assert.ok(more)
  const conflict = await h.run({ command: '/import-codex parent --execute' })
  assert.match(conflict.result.text, /冲突 parent.*两边均新增/)
  assert.deepEqual(conflict.sessions, continued.sessions)
})


test('interrupted native relationship publication resumes without duplicating transcript or catalog', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('recover-parent', turn('recover parent'))
  await h.source('recover-child', turn('recover child'), { parent: 'recover-parent' })
  const interrupted = await h.run({ command: '/import-codex recover-parent --execute', failMetadataOnce: true })
  assert.match(interrupted.result.text, /injected metadata interruption/)
  const recovered = await h.run({ command: '/import-codex recover-parent --execute', catalogs: [targetId('recover-parent')] })
  assert.match(recovered.result.text, /成功 recover-parent/)
  assert.equal(recovered.catalogs[0].length, 1)
  const parent = recovered.sessions.find(x => x.header.id === targetId('recover-parent'))
  assert.equal(parent.events.filter(e => e.type === 'subagent/catalog').length, 1)
  assert.equal(parent.events.filter(e => e.type === 'user/message' && e.data.content.some(b => b.text === 'recover parent')).length, 1)
  assert.equal(parent.events.at(-1).type, 'codex-migration/checkpoint')
})


test('relationship publication before-write interruption reports partial completion and can resume', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('before-parent', turn('before parent'))
  await h.source('before-child', turn('before child'), { parent: 'before-parent' })
  const interrupted = await h.run({ command: '/import-codex before-parent --execute', failMetadataBefore: true })
  assert.match(interrupted.result.text, /部分完成 before-parent/)
  const report = interrupted.commandReports.at(-1).data.groups[0]
  assert.equal(report.results.length, 2)
  assert.equal(report.failures[0].phase, '发布父子关系及缺失说明')
  // Native continuation does not add a Codex suffix; it must not strand an
  // already-imported child's missing native catalog after an interruption.
  await h.run({ resume: targetId('before-parent') })
  const recovered = await h.run({ command: '/import-codex before-parent --execute', catalogs: [targetId('before-parent')] })
  assert.match(recovered.result.text, /成功 before-parent/)
  assert.equal(recovered.catalogs[0].length, 1)
  const skipped = await h.run({ command: '/import-codex before-parent --execute' })
  assert.match(skipped.result.text, /跳过 before-parent/)
})

test('manual retry updates an obsolete missing-history notice without rewriting source prompts', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('notice-parent', turn('notice parent'))
  const child = await h.source('notice-child', [], { parent: 'notice-parent' })
  await appendFile(child, '{broken}\n')
  const partial = await h.run({ command: '/import-codex notice-parent --execute' })
  assert.match(partial.result.text, /部分完成 notice-parent/)
  await h.source('notice-child', turn('restored child'), { parent: 'notice-parent' })
  const retry = await h.run({ command: '/import-codex notice-parent --execute' })
  assert.match(retry.result.text, /成功 notice-parent/)
  const parent = retry.sessions.find(x => x.header.id === targetId('notice-parent'))
  const update = parent.events.findLast(e => e.type === 'user/message' && e.data.id.startsWith('codex-context-missing-'))
  assert.equal(update.surfaceOp.op, 'replace')
  const resumed = await h.run({ resume: parent.header.id })
  assert.match(JSON.stringify(resumed.requests), /此前提示缺失的子 agent 历史已在本次手动导入中迁入/)
  assert.doesNotMatch(JSON.stringify(resumed.requests), /子 agent notice-child 历史未迁入/)
  assert.equal(parent.events.filter(e => e.type === 'user/message' && e.data.content.some(b => b.text === 'notice parent')).length, 1)
})
