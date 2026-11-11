import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, row, turn } from './harness.mjs'
import { targetId } from '../src/source.js'

test('native request overflow retries once without old tool pairs and preserves all prose', { timeout: 60_000 }, async t => {
  const h = await harness(t)
  const rows = turn('verbatim user prompt')
  rows.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'old', arguments: '{"q":"original"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'old', output: 'old evidence' }))
  await h.source('retry-parent', rows)
  await h.run({ command: '/import-codex retry-parent --execute' })
  const resumed = await h.run({ resume: targetId('retry-parent'), overflow: 1 })
  assert.equal(resumed.requests.length, 2)
  assert.match(JSON.stringify(resumed.requests[0]), /old evidence/)
  assert.doesNotMatch(JSON.stringify(resumed.requests[1]), /old evidence/)
  assert.match(JSON.stringify(resumed.requests[1]), /verbatim user prompt.*answer: verbatim user prompt/)
  assert.match(JSON.stringify(resumed.requests[1]), /省略了 1 对/)
  assert.ok(JSON.stringify(resumed.sessions).includes('old evidence'))
  const stopped = await h.run({ resume: targetId('retry-parent'), overflow: 10 })
  assert.equal(stopped.requests.length, 2)
  const partial = await h.run({ resume: targetId('retry-parent'), overflow: 10, partialOutput: true })
  assert.equal(partial.requests.length, 1)
})


test('multi-turn native tool use keeps original history and calibrates from new model usage', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('native-parent', turn('preserved history'))
  await h.run({ command: '/import-codex native-parent --execute' })
  const continued = await h.run({ resume: targetId('native-parent'), nativeTool: true, followups: 3, reportedInput: 50_000 })
  assert.equal(continued.toolExecutions, 1)
  assert.equal(continued.requests.length, 4)
  assert.match(JSON.stringify(continued.requests[1]), /new native evidence/)
  for (const request of continued.requests) assert.match(JSON.stringify(request), /preserved history/)
  const audits = continued.sessions[0].events.filter(e => e.type === 'plugin:codex-migration/request-budget').map(e => e.data)
  assert.ok(audits[1].factor > audits[0].factor)
  assert.ok(audits.every(x => x.estimated <= x.budget))
})
