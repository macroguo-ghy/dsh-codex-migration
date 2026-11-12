import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, turn } from './harness.mjs'
import { targetId } from '../src/source.js'

test('oversized first continuation offers model, summary and cancel without losing the submitted prompt', { timeout: 50_000 }, async t => {
  const h = await harness(t)
  await h.source('choice', turn('protected human '.repeat(20_000)))
  await h.run({ command: '/import-codex choice --execute' })
  const result = await h.run({ resume: targetId('choice'), preset: 'standard', outputReserve: 32768,
    modelWindows: { fixture: 200000, large: 1000000 }, contextActions: [
      '/codex-context models $choice', '/codex-context cancel $choice', '/codex-context summarize $choice',
    ] })
  assert.equal(result.requests.length, 0)
  assert.equal(result.summaries, 0)
  const choices = result.sessions[0].events.filter(e => e.type === 'plugin:codex-migration/context-choice')
  assert.ok(choices.length >= 3)
  assert.equal(choices.at(-1).data.status, 'cancelled')
  assert.ok(choices.some(e => e.data.models?.some(model => model.model === 'large' && model.window === 1000000)))
  assert.equal(result.contextResults.at(-1).kind, 'error')
  const saved = result.sessions[0].events.find(e => e.seq === choices[0].data.pendingSeq)
  assert.equal(saved.type, 'user/message')
  assert.equal(saved.data.content[0].text, 'native continuation prompt')
})

test('chunked summaries retain readable progress across a cold retry without reprocessing successful chunks', { timeout: 80_000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('old requirement'), ...turn('middle requirement'), ...turn('latest requirement')]
  rows[2].payload.content[0].text = 'large old response '.repeat(70000)
  await h.source('chunks', rows)
  const imported = await h.run({ command: '/import-codex chunks --execute' })
  const base = { resume: targetId('chunks'), preset: 'standard', window: 200000, outputReserve: 64000,
    contextActions: ['/codex-context summarize $choice', '/codex-context summaries $choice'], timeout: 60000 }
  const failed = await h.run({ ...base, summaryFailureAt: 2 })
  assert.equal(failed.requests.length, 0)
  assert.equal(failed.summaries, 0)
  assert.equal(failed.summaryRequests.length, 2)
  const saved = failed.sessions[0].events.filter(event => event.type === 'plugin:codex-migration/summary-block')
  assert.equal(saved.length, 1)
  assert.equal(failed.sessions[0].events.findLast(event => event.type === 'plugin:codex-migration/context-choice').data.status, 'error')
  assert.equal(failed.sessions[0].events.some(event => event.type === 'plugin:codex-migration/summary-commit'), false)
  const resumed = await h.run(base)
  assert.equal(resumed.requests.length, 1)
  assert.equal(resumed.summaries, 0)
  for (const prompt of ['old requirement', 'middle requirement', 'latest requirement']) {
    assert.ok(resumed.requests[0].some(message => message.role === 'user' && message.content.some(block => block.text === prompt)))
  }
  assert.match(resumed.summaryRequests[0].messages[1].content[0].text, /time=\d{4}-\d{2}-\d{2}T/)
  assert.match(resumed.summaryRequests[0].messages[0].content[0].text, /不要新增建议/)
  assert.match(resumed.contextResults.at(-1).text, /后续保留原文和用户修正优先/)
  assert.match(resumed.contextResults.at(-1).text, /精确来源.*UTF-16/)
  assert.match(resumed.contextResults.at(-1).text, /seq=\d+ from=\d+ to=\d+/)
  const events = resumed.sessions[0].events
  assert.equal(events.filter(event => event.type === 'plugin:codex-migration/summary-block' && event.data.id === saved[0].data.id).length, 1)
  const first = saved[0].data.sources[0]
  assert.equal(resumed.summaryRequests.some(request => JSON.stringify(request).includes('[来源 seq=' + first.seq + ' role=assistant offset=0 ')), false)
  assert.deepEqual(events.slice(0, imported.sessions[0].events.length), imported.sessions[0].events)
  assert.ok(events.some(event => event.type === 'plugin:codex-migration/summary-committed'))
})

test('explicit summary choice uses native compaction while retaining every human prompt and recent input', { timeout: 60_000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('first requirement'), ...turn('second requirement'), ...turn('latest requirement')]
  rows[2].payload.content[0].text = 'historical model body '.repeat(18000)
  await h.source('native-summary', rows)
  const imported = await h.run({ command: '/import-codex native-summary --execute' })
  const continued = await h.run({ resume: targetId('native-summary'), preset: 'standard', window: 200000,
    outputReserve: 64000, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(continued.summaries, 1)
  assert.equal(continued.requests.length, 1)
  for (const prompt of ['first requirement', 'second requirement', 'latest requirement', 'native continuation prompt']) {
    assert.ok(continued.requests[0].some(message => message.role === 'user' && message.content.some(block => block.text === prompt)))
  }
  assert.deepEqual(continued.sessions[0].events.slice(0, imported.sessions[0].events.length), imported.sessions[0].events)
  assert.equal(continued.sessions[0].events.findLast(e => e.type === 'plugin:codex-migration/context-choice').data.status, 'ready')
})

test('oversized old human input can be summarized while recent prompts stay verbatim', { timeout: 60_000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('earlier user instruction '.repeat(45000)), ...turn('用户修正：使用 B'), ...turn('最近要求：保留结果')]
  await h.source('human-summary', rows)
  await h.run({ command: '/import-codex human-summary --execute' })
  const result = await h.run({ resume: targetId('human-summary'), preset: 'standard', window: 200000, outputReserve: 64000,
    summaryText: '当前决定使用 B；较早要求已被用户修正。', contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.summaries, 0)
  assert.ok(result.summaryRequests.length >= 2)
  assert.equal(result.requests.length, 1)
  assert.match(JSON.stringify(result.requests), /当前决定使用 B/)
  for (const prompt of ['最近要求：保留结果', 'native continuation prompt']) {
    assert.ok(result.requests[0].some(message => message.role === 'user' && message.content.some(block => block.text === prompt)))
  }
  const adopted = result.sessions[0].events.findLast(event => event.type === 'plugin:codex-migration/summary-commit')
  assert.equal(adopted.data.phase, 'history')
  assert.match(adopted.data.text, /较早真人输入及模型输出经过摘要/)
})

test('native authentication failures stop without falling back to chunking', { timeout: 50_000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('old requirement'), ...turn('middle requirement'), ...turn('latest requirement')]
  rows[2].payload.content[0].text = 'historical response '.repeat(18000)
  await h.source('auth-stop', rows)
  await h.run({ command: '/import-codex auth-stop --execute' })
  const result = await h.run({ resume: targetId('auth-stop'), preset: 'standard', window: 200000, outputReserve: 64000,
    nativeSummaryFailureCode: 'AUTH', contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.summaries, 1)
  assert.equal(result.summaryRequests.length, 0)
  assert.equal(result.requests.length, 0)
  assert.equal(result.sessions[0].events.findLast(event => event.type === 'plugin:codex-migration/context-choice').data.status, 'error')
})

test('choosing a larger model automatically resumes once without duplicating the human prompt', { timeout: 50_000 }, async t => {
  const h = await harness(t)
  await h.source('model-choice', turn('large preserved user '.repeat(18000)))
  await h.run({ command: '/import-codex model-choice --execute' })
  const result = await h.run({ resume: targetId('model-choice'), preset: 'standard', outputReserve: 64000,
    modelWindows: { fixture: 200000, large: 1000000 }, contextActions: [
      '/codex-context models $choice', '/codex-context model $choice 0', '/codex-context model $choice 0',
    ] })
  assert.equal(result.requests.length, 1)
  assert.equal(result.summaries, 0)
  assert.equal(result.requests[0].filter(message => message.role === 'user' && message.content.some(block => block.text === 'native continuation prompt')).length, 1)
  assert.equal(result.contextResults.at(-1).kind, 'error')
  const finalChoice = result.sessions[0].events.findLast(event => event.type === 'plugin:codex-migration/context-choice').data
  assert.equal(finalChoice.status, 'ready')
  assert.equal(finalChoice.window, 1000000)
  assert.ok(finalChoice.estimated <= finalChoice.budget)
})

test('merging many chunk summaries is budgeted and keeps references to every source segment', { timeout: 65_000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('old goal'), ...turn('middle goal'), ...turn('latest goal')]
  rows[2].payload.content[0].text = 'historical model details '.repeat(190000)
  await h.source('merge', rows)
  await h.run({ command: '/import-codex merge --execute' })
  const result = await h.run({ resume: targetId('merge'), preset: 'standard', window: 100000,
    summaryText: 'summary detail '.repeat(500), contextActions: ['/codex-context summarize $choice'], timeout: 50000 })
  assert.equal(result.requests.length, 1)
  const blocks = result.sessions[0].events.filter(event => event.type === 'plugin:codex-migration/summary-block')
  assert.ok(blocks.filter(event => event.data.phase === 'assistant').length > 10)
  const merged = blocks.findLast(event => event.data.phase === 'merge')
  assert.ok(merged)
  const first = blocks.find(event => event.data.phase === 'assistant').data.sources[0]
  assert.ok(merged.data.sources.some(source => source.seq === first.seq && source.from === first.from))
  assert.ok(merged.data.sources.some(source => source.seq === first.seq && source.to === rows[2].payload.content[0].text.length))
})

test('a huge latest historical model output can be summarized without changing its user prompt', { timeout: 50_000 }, async t => {
  const h = await harness(t)
  const rows = turn('keep the original requirement')
  rows[2].payload.content[0].text = 'huge latest model output '.repeat(50000)
  await h.source('latest-output', rows)
  await h.run({ command: '/import-codex latest-output --execute' })
  const result = await h.run({ resume: targetId('latest-output'), preset: 'standard', window: 200000,
    outputReserve: 64000, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.requests.length, 1)
  assert.ok(result.requests[0].some(message => message.role === 'user' && message.content.some(block => block.text === 'keep the original requirement')))
  assert.ok(result.summaryRequests.length > 0)
})

test('a single huge historical human prompt is eligible for summarization but a huge current input is never silently summarized', { timeout: 70_000 }, async t => {
  const h = await harness(t)
  await h.source('single-old', turn('old instruction '.repeat(50000)))
  await h.run({ command: '/import-codex single-old --execute' })
  const old = await h.run({ resume: targetId('single-old'), preset: 'standard', window: 200000,
    outputReserve: 64000, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(old.requests.length, 1)
  assert.equal(old.sessions[0].events.findLast(e => e.type === 'plugin:codex-migration/summary-commit').data.phase, 'history')
  await h.source('huge-current', turn('small history'))
  await h.run({ command: '/import-codex huge-current --execute' })
  const prompt = 'current input must stay exact '.repeat(35000)
  const current = await h.run({ resume: targetId('huge-current'), preset: 'standard', window: 200000,
    outputReserve: 64000, prompt, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(current.requests.length, 0)
  assert.equal(current.summaries, 0)
  assert.equal(current.summaryRequests.length, 0)
  const currentSession = current.sessions.find(session => session.header.id === targetId('huge-current'))
  assert.match(currentSession.events.findLast(e => e.type === 'plugin:codex-migration/context-choice').data.reason, /缩短当前输入/)
  assert.ok(currentSession.events.some(e => e.type === 'user/message' && e.data.content.some(block => block.text === prompt)))
})

test('provider size rejection below the local budget requires an actual summary before retry', { timeout: 60000 }, async t => {
  const h = await harness(t)
  const rows = turn('preserved human input')
  rows[2].payload.content[0].text = 'old model response '.repeat(8000)
  await h.source('provider-summary', rows)
  await h.run({ command: '/import-codex provider-summary --execute' })
  const result = await h.run({ resume: targetId('provider-summary'), preset: 'standard', window: 200000,
    outputReserve: 64000, overflow: 1, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.requests.length, 2)
  assert.ok(result.summaries + result.summaryRequests.length > 0)
  assert.ok(JSON.stringify(result.requests[1]).length < JSON.stringify(result.requests[0]).length * 0.8)
  assert.equal(result.sessions[0].events.findLast(e => e.type === 'plugin:codex-migration/context-choice').data.status, 'ready')
  assert.ok(result.requests[1].some(message => message.role === 'user' && message.content.some(block => block.text === 'native continuation prompt')))
})

test('only explicit summary input-size failures split chunks further before resuming', { timeout: 60000 }, async t => {
  const h = await harness(t)
  const rows = turn('protected current objective')
  rows[2].payload.content[0].text = 'old model evidence '.repeat(40000)
  await h.source('smaller-chunks', rows)
  await h.run({ command: '/import-codex smaller-chunks --execute' })
  const result = await h.run({ resume: targetId('smaller-chunks'), preset: 'standard', window: 200000,
    outputReserve: 64000, summaryInputMaxChars: 100000, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.requests.length, 1)
  assert.ok(result.summaryRequests.some(request => JSON.stringify(request.messages).length > 100000))
  assert.ok(result.summaryRequests.some(request => JSON.stringify(request.messages).length <= 100000))
  const blocks = result.sessions[0].events.filter(event => event.type === 'plugin:codex-migration/summary-block')
  assert.ok(blocks.length > 1)
  assert.ok(blocks.every(event => event.data.estimated <= event.data.budget))
  assert.ok(result.requests[0].some(message => message.role === 'user' && message.content.some(block => block.text === 'native continuation prompt')))
})

test('summary keeps recent small model execution results verbatim, including exact measurements', { timeout: 60000 }, async t => {
  const h = await harness(t)
  const rows = [...turn('old task'), ...turn('latest status question')]
  rows[2].payload.content[0].text = 'old historical model output '.repeat(40000)
  const measurement = '实际已删除1995124260659字节；额外残留未统计；集群实际释放容量未测量。'
  rows[6].payload.content[0].text = measurement
  await h.source('recent-result', rows)
  await h.run({ command: '/import-codex recent-result --execute' })
  const result = await h.run({ resume: targetId('recent-result'), preset: 'standard', window: 200000,
    outputReserve: 64000, contextActions: ['/codex-context summarize $choice'] })
  assert.equal(result.requests.length, 1)
  assert.ok(result.requests[0].some(message => message.role === 'assistant'
    && message.content.some(block => block.type === 'text' && block.text === measurement)))
})
