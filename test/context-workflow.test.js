import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Session, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { installContextWorkflow, currentChoice } from '../src/context-workflow.js'

for (const action of ['model c 0', 'models c']) test('cancel invalidates in-flight ' + action, async () => {
  const session = new Session('race-fixture')
  appendPluginRecord(session, 'plugin:codex-migration/context-choice', { id: 'c', status: 'pending', window: 200000,
    models: [{ provider: 'p', model: 'b' }] })
  let handler, release, entered, followups = 0, selections = 0
  const entry = new Promise(resolve => { entered = resolve }), wait = new Promise(resolve => { release = resolve })
  installContextWorkflow({ effect: () => {}, commands: { register: definition => { handler = definition.handler } },
    get: () => ({ modelCatalog: async () => ({ groups: [{ id: 'p', models: [{ id: 'b' }] }], failures: [] }) }),
    llm: { resolveModelInfo: async () => { entered(); await wait; return { context: { contextWindow: 1000000 } } } },
  }, () => ({ ready: false }))
  const agent = { session, whenIdle: async () => {}, followup: () => followups++, model: { select: () => selections++ } }
  const signal = new AbortController().signal
  const model = handler({ agent, rawInput: action, signal })
  await entry
  await handler({ agent, rawInput: 'cancel c', signal })
  release()
  assert.equal((await model).kind, 'error')
  assert.equal(currentChoice(session).status, 'cancelled')
  assert.equal(selections, 0)
  assert.equal(followups, 0)
})
