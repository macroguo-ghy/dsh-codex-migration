import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

test('budget card remains outside folded analysis and loads an unloaded pair by seq', async () => {
  let plugin, definition, slot, request
  let records = [{ event: { seq: 13, type: 'assistant/message', data: { original: 'call' } } },
    { event: { seq: 14, type: 'tool/call' } },
    { event: { seq: 15, type: 'tool/result', data: { original: 'result' } } }]
  vm.runInNewContext(await readFile(new URL('../src/client-bundle.js', import.meta.url), 'utf8'), {
    AbortSignal,
    window: { __ModuleLoader__: { load(bundle) { plugin = bundle.factory(() => ({})) } } },
  })
  assert.ok(plugin.inject.includes('remote') && plugin.inject.includes('remote.session'))
  plugin.apply({ effect: fn => fn(), uiConversation: { events: { register(value) { definition = value } } },
    slots: { inject: (_name, fn) => fn(), register(value) { slot = value } },
    remote: { session: { async page(value) { request = value; return { ok: true, value: { records } } } } },
  })
  const event = { type: 'plugin:codex-migration/request-budget', seq: 99, data: { omitted: [] } }
  assert.equal(definition.match(event).role, 'start')
  const start = { event, location: { kind: 'turn', turn: { turn: 1 } } }
  const node = definition.buildViewNode({ key: 'fixture', id: '99', start, matches: [start] })
  assert.equal(node.groupTree, 'turn')
  const readOriginal = slot.inject('fixture-session').readOriginal
  const result = JSON.parse(await readOriginal({ assistantSeq: 13, resultSeq: 15 }))
  assert.deepEqual(result.map(event => event.data.original), ['call', 'result'])
  assert.equal(request.address.sessionId, 'fixture-session')
  assert.equal(request.throughSeq, 15)
  assert.equal(request.beforeSeq, 16)
  records = records.slice(0, 1)
  await assert.rejects(() => readOriginal({ assistantSeq: 13, resultSeq: 15 }), /原记录不完整/)
})
