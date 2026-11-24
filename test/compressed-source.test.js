import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { discover } from '../src/source.js'
import { discoverGroups, freezeGroup, load } from '../src/groups.js'
import { row, turn, lines } from './harness.mjs'

test('compressed histories preserve parent groups, matching copies and frozen transcript data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-zstd-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const active = join(root, 'sessions'), archive = join(root, 'archived_sessions')
  await mkdir(active)
  await mkdir(archive)
  for (const [dir, meta] of [[active, { id: 'parent' }], [archive, { id: 'child', parent_thread_id: 'parent' }]]) {
    const path = join(dir, 'rollout-' + meta.id + '.jsonl')
    const data = lines([row('session_meta', meta), ...turn('压缩历史')])
    await writeFile(path + '.zst', zstdCompressSync(data))
    if (meta.id === 'parent') await writeFile(path, data)
  }
  const { paths, titles } = await discover(true, root)
  assert.equal(paths.length, 3)
  const { groups, issues } = await discoverGroups(paths, new Set(), true)
  assert.deepEqual(issues, [])
  assert.equal(groups.length, 1)
  const frozen = await freezeGroup(groups[0], titles)
  assert.deepEqual(frozen.members.map(m => [m.id, m.frozen.count]), [['parent', 1], ['child', 1]])
  assert.match(JSON.stringify((await load(frozen.members[1])).rows), /压缩历史/)
})
