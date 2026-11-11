import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
const exec = promisify(execFile)
export const stamp = '2026-10-01T02:03:04.000Z'
export const row = (type, payload) => ({ type, payload, timestamp: stamp })
export const turn = text => [row('event_msg', { type: 'task_started' }),
  row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }),
  row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer: ' + text }] }),
  row('event_msg', { type: 'task_complete' })]
export const lines = rows => rows.map(x => JSON.stringify(x)).join('\n') + '\n'
export async function harness(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-groups-test-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = join(root, 'project'), codex = join(root, 'codex')
  await mkdir(cwd); await mkdir(join(codex, 'sessions'), { recursive: true }); await mkdir(join(codex, 'archived_sessions'))
  const env = { ...process.env, DSH_HOME: join(root, 'dsh'), CODEX_HOME: codex, DSH_AGENTS_HOME: join(root, 'agents'),
    DSH_TELEMETRY_DISABLED: '1', MIGRATION_PROBE_INPUT: join(root, 'input.json'), MIGRATION_PROBE_OUTPUT: join(root, 'output.json') }
  const repository = fileURLToPath(new URL('..', import.meta.url))
  const packed = (await exec('npm', ['pack', '--silent', '--pack-destination', root], { cwd: repository })).stdout.trim()
  await exec('dsh', ['plugin', '--profile', 'web', 'add', join(root, packed)], { cwd, env, timeout: 20_000 })
  env.NODE_OPTIONS = [env.NODE_OPTIONS, '--import=' + join(root, 'dsh/profiles/web/node_modules/dsh-codex-migration/src/host-bootstrap.js')].filter(Boolean).join(' ')
  const patch = join(root, 'probe.yml')
  await writeFile(patch, '- insert:\n    - id: runtime-probe\n      name: ' + new URL('./runtime-probe.mjs', import.meta.url).href + '\n'
    + (options.mcp ? '    - id: static-mcp\n      name: "@deepseek-ai/dsh-mcp-client"\n      disabled: true\n      config: {serverName: "' + options.mcp + '", transport: http, url: "http://127.0.0.1:1"}\n' : ''))
  return { root, cwd, codex, env,
    async source(id, rows, { parent, archived = false } = {}) {
      const path = join(codex, archived ? 'archived_sessions' : 'sessions', 'rollout-' + id + '.jsonl')
      await writeFile(path, lines([row('session_meta', { id, cwd, timestamp: stamp,
        ...(parent && { thread_source: 'subagent', parent_thread_id: parent, forked_from_id: parent }) }), ...rows]))
      return path
    },
    async run(options) {
      await rm(env.MIGRATION_PROBE_OUTPUT, { force: true }); await writeFile(env.MIGRATION_PROBE_INPUT, JSON.stringify(options))
      await exec('dsh', ['web', '--patch', patch, '--no-open', '--port', '0'], { cwd, env, timeout: 25_000 })
      const result = JSON.parse(await readFile(env.MIGRATION_PROBE_OUTPUT, 'utf8'))
      if (result.error) throw new Error(result.error)
      return result
    },
  }
}
