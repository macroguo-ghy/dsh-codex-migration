import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const home = resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const tracking = join(home, 'codex-migration-workspaces')

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

export async function attachImportedWorkspace(registry, cwd, sessionId) {
  const existing = registry.list().find(workspace => workspace.path === cwd)
  const workspace = existing ?? await registry.create(cwd)
  if (!existing) {
    await mkdir(tracking, { recursive: true, mode: 0o700 })
    const record = { id: workspace.id, path: workspace.path, sessionId }
    await writeFile(join(tracking, workspace.id + '.json'), JSON.stringify(record), { mode: 0o600, flag: 'wx' })
      .catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  await workspace.attachSession(sessionId)
}

export async function removeEmptyWorkspaces(ctx, records) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return 0
  const occupied = new Set((await ctx.sessionPersistence.list()).map(session => session.header.cwd))
  for (const agent of ctx.get('agents')?.list() ?? []) occupied.add(agent.session.header.cwd)
  let removed = 0
  for (const record of records) {
    const workspace = registry.get(record.id)
    if (!workspace || workspace.path !== record.path || workspace.sessionIds.length || occupied.has(record.path)) continue
    if (await registry.delete(record.id)) removed++
  }
  return removed
}

export async function pruneBackedUpWorkspaces(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return 0
  const files = await readdir(tracking).catch(error => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (!files.length) return 0
  const backedUp = new Set()
  const backups = join(home, 'migration-backups')
  for (const batch of await directories(backups)) {
    for (const workspace of await directories(join(backups, batch))) {
      for (const session of await directories(join(backups, batch, workspace))) backedUp.add(session)
    }
  }
  const eligible = []
  for (const file of files.filter(file => file.endsWith('.json'))) {
    const record = JSON.parse(await readFile(join(tracking, file), 'utf8'))
    if (file !== record.id + '.json' || !backedUp.has(record.sessionId)) continue
    eligible.push(record)
  }
  const removed = await removeEmptyWorkspaces(ctx, eligible)
  for (const { id } of eligible) {
    if (!registry.get(id)) await rm(join(tracking, id + '.json'), { force: true })
  }
  return removed
}
