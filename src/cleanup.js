#!/usr/bin/env node
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readdir, realpath, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { createZstdDecompress } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { targetId } from './source.js'

async function importedSession(directory, id) {
  const source = createReadStream(join(directory, 'session.v4.jsonl.zstd'))
  const decoded = createZstdDecompress()
  source.on('error', error => decoded.destroy(error))
  source.pipe(decoded)
  const lines = createInterface({ input: decoded })
  try {
    let header
    for await (const line of lines) {
      const row = JSON.parse(line)
      if (!header) {
        if (row.type !== 'session' || row.version !== 4 || row.id !== id) return false
        header = row
      } else {
        return row.seq === 0 && row.type === 'codex-migration/begin' && row.ignorable === true
          && row.data?.version === 1 && typeof row.data.source === 'string' && targetId(row.data.source) === id
      }
    }
    return false
  } finally {
    lines.close()
    source.destroy()
    decoded.destroy()
  }
}

export async function scan(root) {
  const candidates = []
  const unverified = []
  const workspaces = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const parent = join(root, workspace.name)
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^session-codex-[a-f0-9]{64}$/.test(entry.name)) continue
      const path = join(parent, entry.name)
      if (await importedSession(path, entry.name).catch(() => false)) candidates.push(path)
      else unverified.push(entry.name)
    }
  }
  return { candidates, unverified }
}

async function main() {
  const { values } = parseArgs({ options: {
    execute: { type: 'boolean' }, help: { type: 'boolean' }, 'dsh-home': { type: 'string' },
  } })
  if (values.help) {
    console.log('用法：dsh-codex-cleanup [--dsh-home 目录] [--execute]\n执行前须停止使用该数据目录的全部 DSH 进程。')
    return
  }
  const home = resolve(values['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const root = join(home, 'sessions')
  const { candidates, unverified } = await scan(root)
  console.log('已核验的迁移会话：' + candidates.length + ' 条')
  if (unverified.length) console.log('迁移标记无法核验，保留：\n' + unverified.join('\n'))
  if (!values.execute || !candidates.length) return
  const result = await moveSessions(home, candidates)
  console.log('备份目录：' + result.backup)
  for (const failure of result.failures) console.error('移动失败：' + failure)
  console.log('已移出 ' + result.moved + ' / ' + candidates.length + ' 条')
  if (result.failures.length) process.exitCode = 1
}

export async function moveSessions(home, candidates) {
  const root = join(home, 'sessions')
  const backups = join(home, 'migration-backups')
  await mkdir(backups, { recursive: true, mode: 0o700 })
  const backup = await mkdtemp(join(backups, 'codex-'))
  const failures = []
  let moved = 0
  for (const path of candidates) {
    const destination = join(backup, relative(root, path))
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await rename(path, destination)
      moved++
    } catch (error) {
      failures.push(relative(root, path) + '（' + error.code + '）')
    }
  }
  return { moved, backup, failures }
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1]).catch(() => '')).href) {
  try { await main() } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
