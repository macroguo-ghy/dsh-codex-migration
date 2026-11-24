import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { targetId } from '../src/source.js'

test('cleanup previews and permanently deletes only confirmed verified imported sessions', async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cleanup-test-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'sessions', 'project')
  const imported = targetId('source')
  const unverified = targetId('other-source')
  const artifact = 'session.v4.jsonl.zstd'
  for (const id of [imported, unverified, 'session-native']) {
    const directory = join(root, id)
    await mkdir(directory, { recursive: true })
    const data = [
      { type: 'session', version: 4, id },
      { type: 'codex-migration/begin', seq: 0, ignorable: true, data: { version: 1, source: 'source' } },
      { type: 'codex-migration/checkpoint', seq: 1 },
      { type: 'turn/start', seq: 2, data: { turn: 1 } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n'
    await writeFile(join(directory, artifact), zstdCompressSync(data))
  }
  const run = (...args) => execFileSync(process.execPath,
    [fileURLToPath(new URL('../src/cleanup.js', import.meta.url)), '--dsh-home', home, ...args],
    { encoding: 'utf8' })
  const [group] = JSON.parse(run())
  assert.equal(group.root, 'source')
  assert.equal(group.members[0].continued, true)
  assert.equal((await readdir(root)).length, 3)
  const output = run('--execute', '--root', group.root, '--scope', group.scope, '--confirm-continued')
  assert.match(output, /已永久删除 1 条/)
  assert.deepEqual((await readdir(root)).sort(), [unverified, 'session-native'].sort())
  assert.deepEqual(JSON.parse(run()), [])
})
