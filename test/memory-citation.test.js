import assert from 'node:assert/strict'
import { test } from 'node:test'
import { conversationPreview } from '../src/conversation-preview.js'
import { convertTurns } from '../src/convert.js'
import { splitTurns } from '../src/source.js'
import { turn } from './harness.mjs'

test('strip only complete assistant citation footers from new imports and previews', async () => {
  const citation = '<oai-mem-citation>\n<citation_entries>MEMORY.md:703-703|note=[throughput]</citation_entries>\n<rollout_ids></rollout_ids>\n</oai-mem-citation>'
  const input = turn(citation)
  input[2].payload.content = ['正文\n\n' + citation.slice(0, 7), citation.slice(7)].map(text => ({ type: 'output_text', text }))
  const source = { path: '/sessions/test', meta: {}, rows: input.map((row, i) => ({ row, line: JSON.stringify(row), lineNumber: i + 1 })) }
  assert.deepEqual(conversationPreview(source).map(m => m.text), [citation, '正文'])
  for (const version of [5, 6]) {
    const events = []
    const emit = (type, data) => { const event = { type, data }; events.push(event); return event }
    emit.next = () => events.length
    await convertTurns({ get() {} }, source, splitTurns(source).turns, 0, emit, new Set(), version)
    const reply = events.find(e => e.type === 'assistant/message').data.message.content
    assert.equal(reply.map(b => b.text).join(''), version === 5 ? '正文\n\n' + citation : '正文')
    assert.equal(events.find(e => e.type === 'user/message').data.content[0].text, citation)
  }
})
