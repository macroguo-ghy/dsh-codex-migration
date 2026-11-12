import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { row, turn, lines } from './harness.mjs'
import { freezeMember, load } from '../src/groups.js'
import { splitTurns } from '../src/source.js'

test('preview cutoff accepts append but rejects prefix edits and does not import later turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-cutoff-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'rollout-a.jsonl'), meta = { id: 'a', cwd: dir }
  const initial = [row('session_meta', meta), ...turn('first')]
  await writeFile(path, lines(initial))
  const node = { id: 'a', meta, paths: [path] }
  const frozen = await freezeMember(node)
  await writeFile(path, lines([...initial, ...turn('later')]))
  assert.equal(splitTurns(await load({ ...node, frozen })).turns.length, 1)
  await writeFile(path, lines([row('session_meta', meta), ...turn('edited'), ...turn('later')]))
  await assert.rejects(load({ ...node, frozen }), /预览.*改写|截断/)
})

test('a torn appended tail outside the frozen cutoff does not block a valid reviewed prefix', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-tail-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'rollout-a.jsonl'), meta = { id: 'a', cwd: dir }
  const initial = lines([row('session_meta', meta), ...turn('reviewed prefix')])
  await writeFile(path, initial)
  const node = { id: 'a', meta, paths: [path] }, frozen = await freezeMember(node)
  await writeFile(path, initial + '{"type":"response_item","payload":')
  assert.equal(splitTurns(await load({ ...node, frozen })).turns.length, 1)
})
