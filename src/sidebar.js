export function refreshImportedSidebar(ctx, reader, events) {
  const cache = ctx.get('sessionProjectionCache')
  if (!cache || reader.header.origin === 'subagent') return
  const { header, inheritedEventCount } = reader
  const snapshot = cache.coldSnapshot(header, inheritedEventCount, events)
  const { title, sessionListMetadata } = snapshot.values
  if (typeof title !== 'string' || !title || !header.cwd) return
  // The list controller does not observe direct persistence writes. Publish
  // the cold summary now, while the cache writes its checkpoint in background.
  ctx.emit('api-session/added', {
    sessionId: header.id,
    updatedAt: Math.max(header.createdAt, sessionListMetadata?.lastPromptAt ?? 0),
    agentAvailable: false,
    formatStatus: 'current',
    running: false,
    blank: sessionListMetadata?.blank ?? false,
    cwd: header.cwd,
    projections: { kind: 'cached', asOfSeq: snapshot.asOfSeq, values: { title } },
  })
}

export async function backfillImportedSidebar(ctx) {
  const cache = ctx.get('sessionProjectionCache')
  if (!cache) return
  const persistence = ctx.sessionPersistence
  for (const { header } of await persistence.list()) {
    if (header.origin === 'subagent' || !/^session-codex-[a-f0-9]{64}$/.test(header.id) ||
      ctx.get('sessions')?.get(header.id) || cache.cachedSnapshot(header, ['title'])?.values.title) continue
    try {
      const reader = await persistence.open(header.id, 'read')
      try {
        const { events } = await reader.read()
        if (events[0]?.type === 'codex-migration/begin') refreshImportedSidebar(ctx, reader, events)
      } finally { await reader.close() }
    } catch (error) {
      ctx.logger.warn('codex-migration: 更新侧边栏标题失败：' + error.message)
    }
  }
}
