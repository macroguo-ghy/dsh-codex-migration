import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertStoredBatch, completedImports, storageHash } from '../src/integrity.js'

test('storage receipts detect content, order and source changes while allowing object key order', () => {
  const marker = { source: 'fixture', count: 1, hash: 'source-hash' }
  const prefix = [
    { seq: 0, type: 'codex-migration/begin', data: marker },
    { seq: 1, type: 'user/message', data: { content: [{ text: '  original\n', type: 'text' }], source: { kind: 'user' } } },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } },
  ]
  const stored = [...prefix, { seq: 3, type: 'codex-migration/checkpoint', data: { ...marker, storageHash: storageHash(prefix) } }]
  assert.equal(completedImports(stored).length, 1)
  assert.equal(storageHash(prefix), storageHash(prefix.map(event => ({ data: event.data, type: event.type, seq: event.seq }))))
  for (const change of [
    events => { events[1].data.content[0].text = 'original' },
    events => { events[1].data.source.kind = 'codex-imported-context' },
    events => { [events[1], events[2]] = [events[2], events[1]] },
    events => { events.splice(2, 1) },
  ]) {
    const corrupted = structuredClone(stored)
    change(corrupted)
    assert.throws(() => completedImports(corrupted), /存储保真校验失败/)
    assert.throws(() => assertStoredBatch(stored, corrupted), /存储保真校验失败/)
  }
})
