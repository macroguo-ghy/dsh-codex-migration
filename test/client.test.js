import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

test('budget card remains outside folded analysis and loads an unloaded pair by seq', async () => {
  let plugin, definition, reasoning, slot, request
  const requests = []
  let records = [{ event: { seq: 13, type: 'assistant/message', data: { original: 'call' } } },
    { event: { seq: 14, type: 'tool/call' } },
    { event: { seq: 20, type: 'assistant/message', data: { unrelated: 'interleaved call' } } },
    { event: { seq: 21, type: 'tool/result', data: { unrelated: 'interleaved result' } } },
    { event: { seq: 50, type: 'tool/result', data: { original: 'result' } } }]
  vm.runInNewContext(await readFile(new URL('../src/client-bundle.js', import.meta.url), 'utf8'), {
    AbortSignal,
    window: { __ModuleLoader__: { load(bundle) { plugin = bundle.factory(() => ({})) } } },
  })
  assert.ok(plugin.inject.includes('remote'))
  const clientContext = { effect: fn => fn(), uiConversation: { events: { register(value) { if (value.kind === 'codex-migration-budget') definition = value; if (value.kind === 'codex-migration-reasoning-summary') reasoning = value } } },
    slots: { inject: (_name, fn) => fn(), register(value) { if (value.key === 'codex-migration-budget') slot = value } },
    remote: { $mount: async () => {}, session: { async page(value) { request = value; requests.push(value)
      return { ok: true, value: { records: records.filter(record => record.event.seq <= value.throughSeq).slice(-value.maxMessages) } } } } },
  }
  clientContext.plugin = child => { if (child.inject.includes('remote.session')) child.apply(clientContext) }
  await plugin.apply(clientContext)
  const imported = (seq, content) => ({ seq, type: 'assistant/message', data: { turn: 1, step: 1,
    message: { id: 'codex-message-' + seq, source: { provider: 'codex' }, content } } })
  const r = imported(6, [{ type: 'reasoning', text: 'readable historical summary' }])
  const rMatch = { event: r, location: { kind: 'turn', turn: { turn: 1 } } }
  let state = reasoning.start({}, rMatch)
  const context = () => ({ key: 'reasoning', id: '1:1', start: rMatch, matches: [rMatch], state })
  assert.equal(reasoning.buildViewNode(context()), null, 'native final reasoning is not duplicated')
  state = reasoning.update({ state }, { event: imported(8, [{ type: 'text', text: 'final body' }]) })
  assert.equal(reasoning.buildViewNode(context()).data.items[0].texts[0], 'readable historical summary')
  state = reasoning.update({ state }, { event: imported(10, [{ type: 'reasoning', text: 'native current reasoning' }, { type: 'text', text: 'answer' }]) })
  assert.equal(reasoning.buildViewNode(context()).data.items.length, 1, 'only overwritten reasoning is projected')
  const event = { type: 'plugin:codex-migration/request-budget', seq: 99, data: { omitted: [] } }
  assert.equal(definition.match(event).role, 'start')
  const start = { event, location: { kind: 'turn', turn: { turn: 1 } } }
  const node = definition.buildViewNode({ key: 'fixture', id: '99', start, matches: [start] })
  assert.equal(node.groupTree, 'turn')
  const readOriginal = slot.inject('fixture-session').readOriginal
  const result = JSON.parse(await readOriginal({ assistantSeq: 13, resultSeq: 50 }))
  assert.deepEqual(result.map(event => event.data.original), ['call', 'result'])
  assert.equal(request.address.sessionId, 'fixture-session')
  assert.equal(request.throughSeq, 50)
  assert.equal(request.beforeSeq, 51)
  assert.deepEqual(requests.map(r => r.throughSeq), [13, 50])
  await readOriginal({ assistantSeq: 13, resultSeq: 50 }, {
    kind: 'subagent', parentSessionId: 'parent', childSessionId: 'fixture-session', mode: 'continuable',
  })
  assert.equal(request.address.kind, 'subagent')
  assert.equal(request.address.parentSessionId, 'parent')
  records = records.slice(0, 1)
  await assert.rejects(() => readOriginal({ assistantSeq: 13, resultSeq: 50 }), /原记录不完整/)
})
