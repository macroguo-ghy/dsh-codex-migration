import assert from 'node:assert/strict'
import { test } from 'node:test'
import { harness, row, turn } from './harness.mjs'

test('preview attributes explicit MCP namespaces and compares configuration without connecting', { timeout: 40_000 }, async t => {
  const h = await harness(t, { mcp: 'docs', hotInstall: true })
  const rows = turn('dependencies')
  rows.splice(2, 0,
    row('response_item', { type: 'function_call', name: 'mcp__docs__read', call_id: 'docs', arguments: '{}' }),
    row('response_item', { type: 'function_call_output', call_id: 'docs', output: 'old docs result' }),
    row('response_item', { type: 'function_call', name: 'mcp__absent__read', call_id: 'absent', arguments: '{}' }),
    row('response_item', { type: 'function_call_output', call_id: 'absent', output: 'old result' }))
  await h.source('dependency-parent', rows)
  const preview = await h.run({ command: '/import-codex dependency-parent', hotCycle: true })
  assert.match(preview.result.text, /docs.*已配置/)
  assert.match(preview.result.text, /absent.*未配置/)
  assert.match(preview.result.text, /静态配置.*不代表.*可用/)
  assert.deepEqual(preview.sessions, [])
  assert.equal(preview.commandReports.length, 1)
  assert.equal(preview.commandReports[0].data.groups[0].results[0].dependencies[0].name, 'docs')
  assert.equal(preview.disabledCommand, null)
  assert.match(preview.reenabledResult.text, /Codex 导入预览/)
  assert.equal(preview.reenabledReports.length, 2)
})
