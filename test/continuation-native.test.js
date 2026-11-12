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

test('initial continuation omits old tool pairs, retains prose and reasoning, and survives cold plugin removal', { timeout: 60_000 }, async t => {
  const h = await harness(t)
  const rows = turn('exact human prompt')
  rows.splice(2, 0,
    row('response_item', { type: 'reasoning', summary: [{ text: 'exact readable reasoning' }] }),
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'heavy', arguments: JSON.stringify({ q: 'old argument'.repeat(50_000) }) }),
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'recent', arguments: '{"q":"recent"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'recent', output: 'retained recent evidence' }),
    row('response_item', { type: 'function_call_output', call_id: 'heavy', output: 'old result'.repeat(50_000) }))
  await h.source('large-parent', rows)
  const imported = await h.run({ command: '/import-codex large-parent --execute' })
  const id = targetId('large-parent')
  const continued = await h.run({ resume: id, preset: 'standard', window: 200_000, outputReserve: 32_768, nativeTool: true })
  assert.equal(continued.summaries, 0)
  assert.equal(continued.preset, 'standard')
  assert.equal(continued.compactionPolicy.auto, true)
  assert.equal(continued.toolExecutions, 1)
  assert.equal(continued.requests.length, 2)
  for (const request of continued.requests) {
    const wire = JSON.stringify(request)
    assert.match(wire, /exact human prompt/)
    assert.match(wire, /answer: exact human prompt/)
    assert.match(wire, /exact readable reasoning/)
    assert.match(wire, /retained recent evidence/)
    assert.match(wire, /已省略.*工具/)
    assert.equal(/old argument|old result/.test(wire), false)
    assert.ok(!request.some(m => m.role === 'tool' && m.toolCallId === 'heavy'))
  }
  assert.deepEqual(continued.sessions[0].events.slice(0, imported.sessions[0].events.length), imported.sessions[0].events)
  const preparation = continued.sessions[0].events.find(e => e.type === 'plugin:codex-migration/request-budget')
  assert.deepEqual(preparation.data.omitted.map(p => p.callId), ['heavy'])
  assert.equal(preparation.data.retainedPairs, 1)
  const pair = preparation.data.omitted[0]
  const originalSeqs = [pair.assistantSeq, pair.resultSeq]
  const reopened = await h.run({ resume: id, window: 200_000, outputReserve: 32_768, disableMigration: true,
    pageRequests: originalSeqs.map(seq => ({ address: { kind: 'session', sessionId: id }, throughSeq: seq, beforeSeq: seq + 1, maxMessages: 1 })) })
  assert.equal(reopened.requests.length, 1)
  assert.doesNotMatch(JSON.stringify(reopened.requests), /old argument|old result/)
  assert.match(JSON.stringify(reopened.requests), /exact readable reasoning/)
  for (const [index, page] of reopened.originalPages.entries()) {
    assert.ok(page.records.some(record => record.event.seq === originalSeqs[index]))
  }
  const interrupted = await harness(t)
  const events = continued.sessions[0].events
  const cut = events.findIndex(e => e.type === 'developer/message' && e.data.message.id.startsWith('codex-omitted-node-')) + 1
  assert.ok(cut > 0)
  await interrupted.run({ seedPartial: { header: continued.sessions[0].header, events: events.slice(0, cut) } })
  const repaired = await interrupted.run({ resume: id, preset: 'standard', window: 200_000, outputReserve: 32_768 })
  assert.equal(repaired.requests.length, 1)
  assert.equal(repaired.summaries, 0)
  assert.equal(/old argument|old result/.test(JSON.stringify(repaired.requests)), false)
  assert.match(JSON.stringify(repaired.requests), /exact readable reasoning/)
})

test('protected prose above the native threshold is blocked without summaries and a larger model recovers live and cold', { timeout: 65_000 }, async t => {
  const h = await harness(t)
  const protectedPrompt = 'exact protected prompt '.repeat(11_000)
  await h.source('protected-parent', turn(protectedPrompt))
  await h.run({ command: '/import-codex protected-parent --execute' })
  const id = targetId('protected-parent')
  const options = { resume: id, preset: 'standard', outputReserve: 32_768, modelWindows: { fixture: 200_000, large: 512_000 } }
  const blocked = await h.run(options)
  assert.equal(blocked.requests.length, 0)
  assert.equal(blocked.summaries, 0)
  assert.match(JSON.stringify(blocked.turnErrors), /请换更大上下文窗口/)
  const recovered = await h.run({ ...options, switchAfterFailure: true })
  assert.equal(recovered.beforeSwitch.requests, 0)
  assert.equal(recovered.beforeSwitch.summaries, 0)
  assert.equal(recovered.summaries, 0)
  assert.equal(recovered.requests.length, 1)
  assert.ok(recovered.requests[0].some(m => m.role === 'user' && m.content.some(b => b.text === protectedPrompt)))
  assert.ok(recovered.requests[0].some(m => m.role === 'assistant' && m.content.some(b => b.text === 'answer: ' + protectedPrompt)))
  await h.source('cold-protected', turn(protectedPrompt))
  await h.run({ command: '/import-codex cold-protected --execute' })
  const coldOptions = { ...options, resume: targetId('cold-protected') }
  assert.equal((await h.run(coldOptions)).requests.length, 0)
  const cold = await h.run({ ...coldOptions, model: 'large' })
  assert.equal(cold.requests.length, 1)
  assert.equal(cold.summaries, 0)
})

test('native automatic summarization remains available after initial continuation succeeds', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('growing-parent', turn('original small history'))
  await h.run({ command: '/import-codex growing-parent --execute' })
  const continued = await h.run({ resume: targetId('growing-parent'), preset: 'standard', window: 200_000,
    followups: 3, followupText: 'new conversation growth '.repeat(30_000) })
  assert.equal(continued.requests.length, 3)
  assert.ok(continued.summaries > 0)
  assert.ok(continued.sessions[0].events.some(e => e.type === 'compaction/summary'))
})

test('a provider rejecting the first context requests a larger window without automatic summary', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  await h.source('provider-overflow', turn('preserved prompt and answer'))
  await h.run({ command: '/import-codex provider-overflow --execute' })
  const continued = await h.run({ resume: targetId('provider-overflow'), preset: 'standard', window: 200_000, overflow: 1 })
  assert.equal(continued.requests.length, 1)
  assert.equal(continued.summaries, 0)
  assert.match(JSON.stringify(continued.turnErrors), /请换更大上下文窗口/)
})

test('tool IDs reused in later turns retain the correct recent result', { timeout: 45_000 }, async t => {
  const h = await harness(t)
  const old = turn('old preserved prompt'), recent = turn('recent preserved prompt')
  old.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'reused', arguments: JSON.stringify({ q: 'large old argument'.repeat(30_000) }) }),
    row('response_item', { type: 'function_call_output', call_id: 'reused', output: 'large old result'.repeat(30_000) }))
  recent.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'lookup', call_id: 'reused', arguments: '{"q":"recent"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'reused', output: 'correct recent result' }))
  await h.source('reused-id', [...old, ...recent])
  await h.run({ command: '/import-codex reused-id --execute' })
  const continued = await h.run({ resume: targetId('reused-id'), preset: 'standard', window: 200_000, outputReserve: 32_768 })
  assert.equal(continued.requests.length, 1)
  const wire = JSON.stringify(continued.requests)
  assert.match(wire, /correct recent result/)
  assert.equal(/large old argument|large old result/.test(wire), false)
  assert.equal(continued.summaries, 0)
})
