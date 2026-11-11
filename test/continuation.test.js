import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fitImportedRequest } from '../src/continuation.js'

test('outgoing budget removes only oldest paired import blocks and preserves the source', () => {
  const text = value => ({ type: 'text', text: value })
  const call = id => ({ type: 'tool-call', id, name: 'lookup', input: {} })
  const result = (id, value, prefix = 'codex-result-') => ({
    id: prefix + id, role: 'tool', toolCallId: id, content: [text(value)],
  })
  const reply = text('model output alongside an old call')
  const original = [
    { id: 'p1', role: 'user', content: [text('  preserve my prompt verbatim\n')] },
    { id: 'codex-message-1', role: 'assistant', content: [reply, call('old')] },
    result('old', 'x'.repeat(3000)),
    { id: 'codex-message-2', role: 'assistant', content: [call('new')] },
    result('new', 'new evidence'),
    { id: 'local', role: 'assistant', content: [call('local')] },
    result('local', 'local evidence', 'result-'),
    { id: 'p2', role: 'user', content: [text('continue')] },
  ]
  const estimateMessage = message => JSON.stringify(message).length
  const nodes = original.map((message, seq) => ({ seq, tokens: estimateMessage(message) }))
  const meter = { estimateMessage, measure: () => ({
    nodes, surfaceTokens: nodes.reduce((sum, node) => sum + node.tokens, 0),
  }) }
  const session = { id: 'fixture', requestHeader: () => ({}), eventAt: seq => original[seq],
    deriveEventMessage: event => event }
  const request = { messages: original, maxTokens: 200 }
  const audit = []
  const record = data => audit.push(data)
  const full = fitImportedRequest(meter, session, request, 10_000, record)
  const note = messages => messages.find(message => message.id === 'codex-migration-omitted-tools')
  const withoutNotice = messages => messages.filter(message => message !== note(messages))
  assert.deepEqual(withoutNotice(full.messages), original)
  assert.match(note(full.messages).content[0].text, /来自旧 Codex 运行环境.*当前可用工具和参数.*即使名称相同/)
  assert.equal(audit[0].omitted.length, 0)
  const fitted = fitImportedRequest(meter, session, request, 2000, record)
  assert.equal(fitted.messages[0], original[0])
  assert.deepEqual(fitted.messages[1].content, [reply])
  assert.deepEqual(withoutNotice(fitted.messages).slice(2), original.slice(3))
  assert.match(note(fitted.messages).content[0].text, /省略了 1 对.*lookup ×1.*seq 1–2/)
  assert.equal(fitted.messages.indexOf(note(fitted.messages)) + 1, fitted.messages.indexOf(original[5]))
  assert.equal(fitted.messages.at(-1), original.at(-1))
  assert.deepEqual(audit[1].omitted, [{ name: 'lookup', callId: 'old', assistantSeq: 1, resultSeq: 2 }])
  assert.equal(audit[1].retainedPairs, 1)
  assert.equal(audit[1].outputReserve, 200)
  assert.deepEqual(original[1].content, [reply, call('old')])
  assert.throws(() => fitImportedRequest(meter, session, request, 600, record), /更大的模型/)
  assert.equal(audit.length, 2)
})
