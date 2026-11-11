import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, row, turn } from './harness.mjs'
import { targetId } from '../src/source.js'

test('standard native continuation preserves imported evidence and uses new tools without migration startup hooks', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  const rows = turn('preserved history')
  rows.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'old', arguments: '{"q":"original"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'old', output: 'old evidence' }))
  await h.source('native-parent', rows)
  await h.run({ command: '/import-codex native-parent --execute' })
  const continued = await h.run({ resume: targetId('native-parent'), nativeTool: true, followups: 3 })
  assert.equal(continued.toolExecutions, 1)
  assert.equal(continued.requests.length, 4)
  assert.match(JSON.stringify(continued.requests[1]), /new native evidence/)
  for (const request of continued.requests) {
    assert.match(JSON.stringify(request), /preserved history/)
    assert.match(JSON.stringify(request), /old evidence/)
    assert.match(JSON.stringify(request), /Codex 历史工具说明/)
  }
  assert.ok(!continued.sessions[0].events.some(e => e.type === 'plugin:codex-migration/request-budget'))
})
