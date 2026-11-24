import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MigrationService } from '../src/migration-service.js'
import { row, turn, lines } from './harness.mjs'

test('group headers are browsable before preflight and an unfinished preview cannot be submitted', async t => {
  const root = await mkdtemp(join(tmpdir(), 'migration-preview-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [dir, id] of [['sessions', 'active'], ['archived_sessions', 'archived'], ['sessions', 'side'], ['sessions', 'fork']]) {
    await mkdir(join(root, dir), { recursive: true })
    await writeFile(join(root, dir, 'rollout-' + id + '.jsonl'),
      lines([row('session_meta', { id, cwd: root, ...(id === 'fork' && { source: 'exec' }), ...(['side', 'fork'].includes(id) && { forked_from_id: 'active' }), ...(id === 'side' && { attached_thread: true }) }), ...(id === 'active' ? [row('event_msg', { type: 'item_completed', item: { type: 'EnteredReviewMode' } })] : []), ...turn('review this'), row('event_msg', { type: 'entered_review_mode' })]))
  }
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const ctx = { get: () => undefined, sessionPersistence: { async stat() { entered.resolve(); await release.promise } } }
  const service = await MigrationService.open(ctx, join(root, 'state'))
  try {
    await service.scan(root)
    await entered.promise
    const partial = service.view({ archived: true })
    assert.equal(partial.counts.checking, 4)
    assert.equal(service.view().total, 3)
    assert.equal(partial.actionable, 0)
    await assert.rejects(service.submit({ previewId: partial.previewId }), /校验完成/)
    release.resolve()
    await service.scanPromise
    const complete = service.view({ archived: true })
    assert.equal(complete.previewId, partial.previewId)
    assert.equal(complete.counts.pending, 4)
    assert.equal(complete.counts.checking, 0)
    assert.deepEqual(service.view({ archived: true, hideReview: true }).rows.map(row => row.root).sort(), ['archived', 'fork', 'side'])
    assert.deepEqual(service.view({ archived: true, hideExec: true, hideReview: true }).rows.map(row => row.root).sort(), ['archived', 'side'])
    const visible = service.view({ archived: true, hideSide: true })
    assert.deepEqual(visible.rows.map(row => row.root).sort(), ['active', 'archived', 'fork'])
    assert.equal(visible.actionable, 3)
    assert.equal(service.view({ hideSide: true }).total, 2)
  } finally {
    release.resolve()
    await service.close()
  }
})

test('combined filters and bulk submission use the same scope across pages', async t => {
  const service = new MigrationService({}, {
    list: () => [], active: () => undefined,
    create: async task => ({ ...task, id: 'selected', createdAt: 0 }),
  })
  service.launch = () => Promise.resolve()
  const day = new Date(2026, 10, 23, 12)
  t.mock.timers.enable({ apis: ['Date'], now: day.getTime() })
  const sample = (id, patch = {}) => ({
    root: id, title: id, cwd: '/repo/app/sub', recent: new Date(2026, 10, 17).toISOString(),
    status: 'pending', members: [], frozenGroup: { root: id, members: [] }, ...patch,
  })
  const included = Array.from({ length: 21 }, (_, i) => sample('human-' + i))
  service.preview = { id: 'p', rows: [...included,
    sample('exec', { execSource: true }), sample('review', { review: true }), sample('auto', { automation: true }), sample('side', { sideConversation: true }),
    sample('prefix', { cwd: '/repo/application' }), sample('old', { recent: new Date(2026, 10, 16, 23, 59).toISOString() }),
    sample('late', { recent: new Date(2026, 10, 24).toISOString() })] }
  const query = { hideExec: true, hideReview: true, hideAutomation: true, hideSide: true, projectDir: '/repo/app', period: '7' }
  const explicit = service.view({ ...query, types: ['exec', 'side'] })
  assert.deepEqual(explicit.eligible.map(item => item.id), ['exec', 'side'])
  assert.equal(service.view({ ...query, types: [] }).total, 0)
  const view = service.view(query)
  assert.equal(view.total, 21)
  assert.equal(view.rows.length, 20)
  assert.equal(view.counts.pending, 21)
  assert.equal(service.view({ ...query, page: 1 }).rows.length, 1)
  assert.equal(service.view({ ...query, period: '30' }).total, 22)
  assert.equal(service.view({ ...query, period: 'custom', from: '2026-11-17', to: '2026-11-17' }).total, 21)
  assert.deepEqual(view.eligible.map(item => item.id), included.map(row => row.root))
  await assert.rejects(service.submit({ previewId: 'p', ids: [], requireReady: true }), /请选择/)
  const task = await service.submit({ previewId: 'p', query })
  assert.deepEqual(task.groups.map(group => group.root), included.map(row => row.root))
})
