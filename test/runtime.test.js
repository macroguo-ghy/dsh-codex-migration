import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const repository = fileURLToPath(new URL('..', import.meta.url))
const probe = new URL('./runtime-probe.mjs', import.meta.url).href
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const stamp = '2026-10-01T02:03:04.000Z'
const row = (type, payload) => ({ type, payload, timestamp: stamp })
const event = type => row('event_msg', { type })
const message = (role, text, extra = []) => row('response_item', {
  type: 'message', role, content: [{ type: 'input_text', text }, ...extra],
})
const lines = rows => rows.map(item => JSON.stringify(item)).join('\n') + '\n'
const turn = name => [event('task_started'), message('user', name + ' user'),
  message('assistant', name + ' assistant'), event('task_complete')]

test('packaged command imports and continues native DSH 0.2.2-rc.1 sessions', { timeout: 110_000 }, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-codex-migration-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project')
  const codex = join(root, 'codex')
  const sessions = join(codex, 'sessions')
  const archive = join(codex, 'archived_sessions')
  await Promise.all([mkdir(cwd), mkdir(sessions, { recursive: true }), mkdir(archive, { recursive: true })])
  const source = join(sessions, 'rollout-main.jsonl')
  const initial = [row('session_meta', { id: 'main', timestamp: stamp, cwd }),
    event('task_started'),
    message('developer', 'historical AGENTS.md content'),
    row('world_state', { full: true, state: { agents_md: { text: 'historical AGENTS.md content' } } }),
    message('user', 'original user text', [{ type: 'input_image', image_url: 'data:image/png;base64,' + png },
      { type: 'input_file', filename: 'readme.txt', file_data: 'ZmlsZSB0ZXh0' },
      { type: 'input_image', path: 'missing.png' }]),
    message('user', '<skill>automatically loaded skill</skill>', [{ type: 'input_text', text: 'human text in mixed record' }]),
    message('user', '<skill>user pasted example</skill>'),
    row('event_msg', { type: 'item_completed', item: { type: 'UserMessage', content: [
      { type: 'text', text: '<skill>user pasted example</skill>' },
    ] } }),
    row('response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'automatic guidance without a tag' },
      { type: 'input_text', text: '<skill>literal user example</skill>' },
    ], internal_chat_message_metadata_passthrough: { content_item_metadata: [
      { provenance: { type: 'skills' } }, { provenance: { type: 'user' } },
    ] } }),
    message('user', '<skills_instructions>injected catalog</skills_instructions>'),
    row('response_item', { type: 'reasoning', summary: [{ text: 'original reasoning summary' }], encrypted_content: 'opaque-with-summary' }),
    row('response_item', { type: 'reasoning', summary: [], encrypted_content: 'opaque-no-summary' }),
    row('response_item', { type: 'function_call', call_id: 'call_fixture', name: 'lookup', arguments: '{"key":"probe"}' }),
    row('response_item', { type: 'function_call_output', call_id: 'call_fixture', output: 'original tool result' }),
    message('assistant', 'original assistant text'),
    row('event_msg', { type: 'token_count', info: { last_token_usage: {
      input_tokens: 12, cached_input_tokens: 3, output_tokens: 4, total_tokens: 16,
    } } }),
    event('task_complete')]
  await writeFile(source, lines(initial))
  await writeFile(join(codex, 'session_index.jsonl'), lines([{ id: 'main', thread_name: 'Original Codex title' }]))
  await writeFile(join(sessions, 'rollout-broken.jsonl'), '{malformed}\n')
  await writeFile(join(archive, 'rollout-fork.jsonl'), lines([
    row('session_meta', { id: 'fork', cwd: join(root, 'gone'), forked_from_id: 'main', timestamp: stamp }), ...turn('fork'),
  ]))
  const input = join(root, 'probe-input.json')
  const output = join(root, 'probe-output.json')
  const patch = join(root, 'probe.yml')
  await writeFile(patch, '- insert:\n    - id: runtime-probe\n      name: ' + probe + '\n')
  const env = { ...process.env, DSH_HOME: join(root, 'dsh'), CODEX_HOME: codex,
    DSH_AGENTS_HOME: join(root, 'agents'), DSH_TELEMETRY_DISABLED: '1',
    MIGRATION_PROBE_INPUT: input, MIGRATION_PROBE_OUTPUT: output }
  delete env.NODE_OPTIONS
  assert.equal((await exec('dsh', ['--version'], { env })).stdout.trim(), '0.2.2-rc.1')
  const packed = (await exec('npm', ['pack', '--silent', '--pack-destination', root], { cwd: repository })).stdout.trim()
  await exec('dsh', ['plugin', '--profile', 'web', 'add', join(root, packed)], { cwd, env, timeout: 20_000 })
  const run = async options => {
    await rm(output, { force: true })
    await writeFile(input, JSON.stringify(options))
    const launched = await exec('dsh', ['web', '--patch', patch, '--no-open', '--port', '0'], { cwd, env, timeout: 15_000 })
    const result = JSON.parse(await readFile(output, 'utf8'))
    assert.ok(!result.error, result.error ?? launched.stderr)
    return result
  }
  const preview = await run({ command: '/import-codex' })
  assert.equal(preview.result.text.split('\n')[1], '共 1 个父会话组，包含 0 个子 agent · 待导入 1 · 冲突 0 · 跳过 0 · 关系或源异常 1')
  assert.match(preview.result.text, /首次导入 main Original Codex title/)
  assert.doesNotMatch(preview.result.text, /\bfork\b/)
  assert.deepEqual(preview.sessions, [])
  assert.match(preview.result.text, /加密推理有可读摘要.*1 条/)
  assert.match(preview.result.text, /加密推理无可读摘要.*1 条/)
  assert.match(preview.result.text, /missing.png/)
  assert.match(preview.result.text, /源行/)
  const imported = await run({ command: '/import-codex --all --execute' })
  assert.match(imported.result.text, /异常 rollout-broken/)
  assert.match(imported.result.text, /成功 main/)
  assert.match(imported.result.text, /存储保真校验通过/)
  assert.match(imported.result.text, /missing.png/)
  const [first] = imported.sessions
  const sidebarTitle = rows => rows.find(row => row.sessionId === first.header.id)?.projections?.values.title
  const cleanupPreview = await run({ command: '/cleanup-codex' })
  assert.match(cleanupPreview.result.text, /已核验的导入会话：1 条/)
  assert.deepEqual(cleanupPreview.sessions, imported.sessions)
  assert.equal(sidebarTitle(cleanupPreview.sessionList), 'Original Codex title')
  const unsafeCleanup = await run({ command: '/cleanup-codex --execute' })
  assert.equal(unsafeCleanup.result.kind, 'error')
  assert.match(unsafeCleanup.result.text, /不支持|不是 dsh-start|Could not find service/)
  assert.deepEqual(unsafeCleanup.sessions, imported.sessions)
  assert.equal(sidebarTitle(imported.sidebar), 'Original Codex title')
  assert.equal(first.header.cwd, cwd)
  assert.equal(first.header.version, 4)
  assert.equal(first.header.createdAt, Date.parse(stamp))
  const types = first.events.map(event => event.type)
  assert.ok(types.includes('session/title'))
  assert.ok(imported.workspaces.some(workspace => workspace.sessions.includes(first.header.id)))
  const history = first.events.filter(event => event.type === 'user/message')
  assert.equal(history[0].data.content[1].text, 'historical AGENTS.md content')
  assert.deepEqual(history.slice(0, 5).map(event => event.data.source.kind), [
    'codex-imported-context', 'user', 'codex-imported-context', 'user', 'user',
  ])
  assert.equal(history[2].data.content[0].text, '<skill>automatically loaded skill</skill>')
  assert.equal(history[3].data.content[0].text, 'human text in mixed record')
  const byText = value => history.find(event => event.data.content.some(block => block.text === value))
  assert.equal(byText('automatic guidance without a tag').data.source.kind, 'codex-imported-context')
  assert.equal(byText('<skill>literal user example</skill>').data.source.kind, 'user')
  assert.equal(byText('<skills_instructions>injected catalog</skills_instructions>').data.source.kind, 'codex-imported-context')
  const user = history[1].data.content
  assert.deepEqual(user.map(block => block.type), ['text', 'image', 'file', 'text'])
  assert.equal(user[0].text, 'original user text')
  const result = first.events.find(event => event.type === 'tool/result')
  assert.equal(result.data.message.content[0].text, 'original tool result')
  assert.equal(first.events[result.sourceEventSeqs[0]].data.callId, 'call_fixture')
  const usage = first.events.findLast(event => event.type === 'assistant/message').data.usage
  assert.equal(usage.inputTokens, 9)
  assert.equal(usage.totalTokens, 16)
  const second = turn('second')
  second.splice(2, 0,
    row('compacted', { message: 'readable compaction summary' }),
    row('world_state', { full: true, state: { agents_md: { text: 'historical AGENTS.md content' } } }),
    row('compacted', { replacement_history: [{ type: 'compaction', encrypted_content: 'opaque' }] }),
    row('world_state', { full: true, state: { agents_md: { text: 'updated AGENTS.md content' } } }))
  await appendFile(source, lines(second))
  const increment = await run({ command: '/import-codex main --execute' })
  assert.match(increment.result.text, /增量导入 1 轮/)
  assert.equal(increment.sessions[0].header.id, first.header.id)
  assert.deepEqual(increment.sessions[0].events.slice(0, first.events.length), first.events)
  const newUserText = increment.sessions[0].events.slice(first.events.length)
    .filter(event => event.type === 'user/message')
    .map(event => event.data.content.map(block => block.text).join(' '))
  assert.deepEqual(newUserText, [
    'second user',
    '[Codex 历史上下文：上下文压缩] readable compaction summary',
    '[Codex 历史上下文：上下文压缩] Codex 在此压缩了上下文，原记录未提供可读摘要。',
    '[Codex 历史上下文：AGENTS.md] updated AGENTS.md content',
  ])
  const unchanged = await run({ command: '/import-codex main --execute' })
  assert.match(unchanged.result.text, /跳过 main/)
  assert.deepEqual(unchanged.sessions, increment.sessions)
  const continued = await run({ resume: first.header.id })
  const request = JSON.stringify(continued.requests)
  for (const text of ['original user text', 'original assistant text',
    'original reasoning summary', 'historical AGENTS.md content', 'automatically loaded skill', 'second user', 'native continuation prompt']) {
    assert.ok(request.includes(text), 'missing from continuation request: ' + text)
  }
  assert.doesNotMatch(request, /original tool result/)
  assert.match(request, /Codex 历史工具说明/)
  assert.ok(JSON.stringify(continued.sessions).includes('native continuation answer'))
  const dshOnly = await run({ command: '/import-codex main --execute' })
  assert.match(dshOnly.result.text, /跳过 main/)
  assert.deepEqual(dshOnly.sessions, continued.sessions)
  await appendFile(source, lines(turn('third')))
  const conflictPreview = await run({ command: '/import-codex main' })
  assert.equal(conflictPreview.result.text.split('\n')[1], '共 1 个父会话组，包含 0 个子 agent · 待导入 0 · 冲突 1 · 跳过 0')
  const conflict = await run({ command: '/import-codex main --execute' })
  assert.match(conflict.result.text, /两边均新增/)
  assert.deepEqual(conflict.sessions, continued.sessions)
  await writeFile(source, lines(initial))
  const rewritten = await run({ command: '/import-codex main --execute' })
  assert.match(rewritten.result.text, /历史被改写或截断/)
  assert.deepEqual(rewritten.sessions, continued.sessions)
  const fork = await run({ command: '/import-codex main fork --archived --execute --cwd "' + cwd + '"' })
  assert.match(fork.result.text, /成功 fork/)
  const forkLog = fork.sessions.find(session => session.header.id !== first.header.id)
  assert.equal(forkLog.header.cwd, cwd)
  assert.equal(forkLog.events[0].data.originalCwd, join(root, 'gone'))

  await writeFile(join(sessions, 'rollout-xml-title.jsonl'), lines([
    row('session_meta', { id: 'xml-title', timestamp: stamp, cwd }), event('task_started'),
    message('user', '<skills_instructions>title must ignore injection</skills_instructions>'),
    row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'untagged automatic context' }, { type: 'input_text', text: '<query>检查 SQL</query>' }],
      internal_chat_message_metadata_passthrough: { content_item_metadata: [{}, { provenance: { type: 'user' } }] } }),
    row('event_msg', { type: 'user_message', message: 'untagged automatic context\n<query>检查 SQL</query>' }),
    message('assistant', 'answer'), event('task_complete'),
  ]))
  const xmlTitle = await run({ command: '/import-codex xml-title' })
  assert.match(xmlTitle.result.text, /xml-title <query>检查 SQL<\/query>/)

  // Seed a durable prefix ending between a tool call and its result, as a
  // process crash could. Recovery must continue the exact append without redoing it.
  const interrupted = 'crash-retry'
  await writeFile(join(sessions, 'rollout-' + interrupted + '.jsonl'), lines([
    row('session_meta', { id: interrupted, timestamp: stamp, cwd }), ...initial.slice(1),
  ]))
  const interruptedId = 'session-codex-' + createHash('sha256').update(interrupted).digest('hex')
  const prefix = structuredClone(first.events.slice(0, result.seq))
  prefix[0].data.source = interrupted
  const recovered = await run({
    seedPartial: { header: { ...first.header, id: interruptedId }, events: prefix },
    command: '/import-codex ' + interrupted + ' --execute',
  })
  assert.match(recovered.result.text, /恢复导入 1 轮/)
  const recoveredLog = recovered.sessions.find(session => session.header.id === interruptedId)
  assert.deepEqual(recoveredLog.events.slice(0, prefix.length), prefix)
  assert.equal(recoveredLog.events.filter(event => event.type === 'tool/result').length, 1)
  assert.equal(recoveredLog.events.at(-1).type, 'codex-migration/checkpoint')

  // Old checkpoints lack storage receipts. Reconstruct their original conversion
  // before extending them, and reject modified text before any append.
  for (const damaged of [false, true]) {
    const legacy = damaged ? 'legacy-damaged' : 'legacy'
    const legacyId = 'session-codex-' + createHash('sha256').update(legacy).digest('hex')
    await writeFile(join(sessions, 'rollout-' + legacy + '.jsonl'), lines([
      row('session_meta', { id: legacy, timestamp: stamp, cwd }), ...initial.slice(1), ...turn('legacy increment'),
    ]))
    const events = structuredClone(first.events)
    for (const event of events) {
      if (event.type.startsWith('codex-migration/')) {
        event.data.source = legacy
        delete event.data.storageHash
      }
    }
    if (damaged) events.find(event => event.type === 'user/message' && event.data.source.kind === 'user').data.content[0].text = 'changed stored prompt'
    const result = await run({ seedPartial: { header: { ...first.header, id: legacyId }, events },
      command: '/import-codex ' + legacy + ' --execute' })
    const stored = result.sessions.find(session => session.header.id === legacyId)
    if (damaged) {
      assert.match(result.result.text, /冲突.*存储保真校验失败/)
      assert.deepEqual(stored.events, events)
    } else {
      assert.match(result.result.text, /增量导入 1 轮.*存储保真校验通过/)
      assert.deepEqual(stored.events.slice(0, events.length), events)
    }
  }

  const importedProject = join(root, 'only-imported')
  await mkdir(importedProject)
  await writeFile(join(sessions, 'rollout-workspace.jsonl'), lines([
    row('session_meta', { id: 'workspace', cwd: importedProject, timestamp: stamp }), ...turn('workspace'),
  ]))
  const mounted = await run({ command: '/import-codex workspace --execute' })
  assert.ok(mounted.workspaces.some(workspace => workspace.path === importedProject))
  const cleanup = join(repository, 'src', 'cleanup.js')
  const inventory = await exec(process.execPath, [cleanup, '--dsh-home', env.DSH_HOME], { cwd, env })
  for (const group of JSON.parse(inventory.stdout)) await exec(process.execPath,
    [cleanup, '--dsh-home', env.DSH_HOME, '--execute', '--root', group.root, '--scope', group.scope, '--confirm-continued'], { cwd, env })
  const afterCleanup = await run({ command: '/cleanup-codex' })
  assert.deepEqual(afterCleanup.sessions, [])
  assert.ok(!afterCleanup.workspaces.some(workspace => workspace.path === importedProject))
  assert.ok((await readdir(importedProject)).length === 0)

})
