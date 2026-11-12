import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

export const inject = ['commands', 'agents', 'sessionPersistence', 'sessionQuery', 'llm']

export function apply(ctx) {
  const sidebar = []
  ctx.on('api-session/added', summary => {
    if (summary.sessionId.startsWith('session-codex-')) sidebar.push(summary)
  })
  void ctx.loader.await().then(async () => {
    const input = JSON.parse(await readFile(process.env.MIGRATION_PROBE_INPUT, 'utf8'))
    const output = { sidebar }
    let driver, resumed, adapter
    try {
      if (process.env.MIGRATION_PROBE_HOT_INSTALL) {
        output.hotInstall = await ctx.get('pluginManager').installBundle(process.env.MIGRATION_PROBE_HOT_INSTALL)
      }
      if (input.disableMigration) await ctx.get('pluginManager').setBundleEnabled('dsh-codex-migration', false)
      if (input.failMetadataOnce || input.failMetadataBefore) {
        const persistence = ctx.sessionPersistence
        let failed = false
        const wrap = handle => {
          const append = handle.append.bind(handle)
          handle.append = async events => {
            if (!failed && events.some(event => event.type === 'codex-migration/begin' && event.data.extraEvents)) {
              failed = true
              if (!input.failMetadataBefore) { await append(events.slice(0, -1)); await handle.flush() }
              throw new Error('injected metadata interruption')
            }
            return append(events)
          }
          return handle
        }
        const create = persistence.create.bind(persistence), open = persistence.open.bind(persistence)
        persistence.create = async (...args) => wrap(await create(...args))
        persistence.open = async (...args) => wrap(await open(...args))
      }
      if (input.seedPartial) {
        const writer = await ctx.sessionPersistence.create(input.seedPartial.header)
        try {
          await writer.append(input.seedPartial.events)
          await writer.flush()
        } finally { await writer.close() }
      }
      if (input.command) {
        driver = await ctx.agents.create({
          sessionId: 'migration-test-' + randomUUID(), meta: { cwd: process.cwd() },
          agentOptions: { provider: 'migration-probe', model: 'fixture' },
        })
        output.result = (await ctx.commands.execute(driver.agent, input.command, [], AbortSignal.timeout(60_000)))?.result
        output.commandReports = driver.agent.session.snapshotEvents().filter(e => e.type === 'plugin:codex-migration/report')
        if (input.hotCycle) {
          const manager = ctx.get('pluginManager')
          await manager.setBundleEnabled('dsh-codex-migration', false)
          output.disabledCommand = (await ctx.commands.execute(driver.agent, input.command, [], AbortSignal.timeout(5000)))?.result ?? null
          await manager.setBundleEnabled('dsh-codex-migration', true)
          output.reenabledResult = (await ctx.commands.execute(driver.agent, input.command, [], AbortSignal.timeout(10000)))?.result
          output.reenabledReports = driver.agent.session.snapshotEvents().filter(e => e.type === 'plugin:codex-migration/report')
        }
      }
      if (input.resume) {
        const requests = []
        output.summaries = 0
        if (input.nativeTool) ctx.get('tools').register({
          name: 'migration_probe_read', description: 'Read isolated fixture evidence',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          async execute() { output.toolExecutions = (output.toolExecutions ?? 0) + 1; return 'new native evidence' },
        })
        adapter = ctx.llm.registerAdapter(['migration-probe'], {
          providerInfo: id => ({ id, name: id }),
          providerRetryPolicy: () => undefined,
          imageRequestPricing: () => undefined,
          imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
          listModels: async () => [],
          async resolveModel(provider, model) {
            return { provider, id: model, name: model, context: { contextWindow: input.modelWindows?.[model] ?? input.window ?? 100_000 },
              ...(input.outputReserve === undefined ? {} : { defaultMaxTokens: input.outputReserve }), inputModalities: ['text', 'image'] }
          },
          async prepareCall(provider, model) {
            return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
          },
          async *stream(options) {
            if (options.purpose === 'compaction') output.summaries++
            if (options.purpose === undefined) requests.push(options.messages)
            if (options.purpose === undefined && requests.length <= (input.overflow ?? 0)) {
              if (input.partialOutput) {
                yield { type: 'block-start', index: 0, blockType: 'text' }
                yield { type: 'text-delta', index: 0, text: 'partial output' }
              }
              yield { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'fixture context overflow' } } }
              return
            }
            if (input.reportedInput) yield { type: 'usage', usage: { inputTokens: input.reportedInput,
              outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: input.reportedInput + 5 } }
            if (input.nativeTool && requests.length === 1) {
              yield { type: 'block-start', index: 0, blockType: 'tool-call' }
              yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'new-native-call', name: 'migration_probe_read', arguments: '{}' } }
              yield { type: 'finish', reason: { kind: 'tool-calls' } }
              return
            }
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native continuation answer' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        })
        const prepare = ctx.llm.prepareCall.bind(ctx.llm)
        ctx.llm.prepareCall = (config, ...rest) => {
          if (config.provider !== 'migration-probe') throw new Error('test forbids unmocked model calls: ' + config.provider)
          return prepare(config, ...rest)
        }
        resumed = await ctx.agents.resume({ resumeSessionId: input.resume,
          agentOptions: { provider: 'migration-probe', model: input.model ?? 'fixture' },
          ...(input.preset ? { setup: async agentCtx => { await ctx.get('agentPresets').mount(agentCtx, input.preset) } } : {}) })
        if (input.model) resumed.agent.model.select({ provider: 'migration-probe', model: input.model })
        if (input.preset) {
          output.preset = ctx.get('agentPresets').composedPreset(resumed.agent.ctx)
          output.compactionPolicy = ctx.get('agentPresets').serviceFor(resumed.agent, 'compaction')?.config
        }
        resumed.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'native continuation prompt' }],
          source: { kind: 'user' } })
        await resumed.agent.whenIdle()
        if (input.switchAfterFailure) {
          output.beforeSwitch = { requests: requests.length, summaries: output.summaries,
            errors: resumed.agent.session.snapshotEvents().filter(e => e.type === 'turn/end' && e.data.reason.kind === 'error').map(e => e.data.reason.error) }
          resumed.agent.model.select({ provider: 'migration-probe', model: 'large' })
          resumed.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'retry with larger window' }], source: { kind: 'user' } })
          await resumed.agent.whenIdle()
        }
        for (let index = 1; index < (input.followups ?? 1); index++) {
          resumed.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input.followupText ?? 'native followup ' + index }], source: { kind: 'user' } })
          await resumed.agent.whenIdle()
        }
        if (input.childTask) {
          await ctx.get('subagents').sendMessage(resumed.agent, input.childTask,
            [{ type: 'text', text: 'continue child fixture' }], { signal: AbortSignal.timeout(10000) })
          await ctx.get('subagents').waitForChildren(resumed.agent)
        }
        output.requests = requests
        output.turnErrors = resumed.agent.session.snapshotEvents().filter(e => e.type === 'turn/end' && e.data.reason.kind === 'error').map(e => e.data.reason.error)
        await resumed.dispose()
        resumed = undefined
      }
      if (input.catalogs) output.catalogs = await Promise.all(input.catalogs.map(id => ctx.get('subagents').listChildren(id)))
      const controller = ctx.get('sessionController')
      if (input.addresses) output.pages = await Promise.all(input.addresses.map(address => controller.page({ address, maxMessages: 20 }, AbortSignal.timeout(5000))))
      if (input.pageRequests) output.originalPages = await Promise.all(input.pageRequests.map(request => controller.page(request, AbortSignal.timeout(5000))))
      if (controller) output.sessionList = (await controller.list({}, AbortSignal.timeout(5000))).items
      output.sessions = []
      for (const item of await ctx.sessionPersistence.list()) {
        if (!item.header.id.startsWith('session-codex-')) continue
        using observation = await ctx.sessionQuery.observeSession(item.header.id)
        output.sessions.push({ header: observation.header, events: observation.events })
      }
      const workspaces = ctx.get('workspaceRegistry')
      if (workspaces) output.workspaces = workspaces.list().map(workspace => ({
        id: workspace.id, path: workspace.path, sessions: workspace.sessionIds,
      }))
    } catch (error) { output.error = error.stack ?? String(error) }
    finally {
      await resumed?.dispose()
      await driver?.dispose()
      await adapter?.()
      await writeFile(process.env.MIGRATION_PROBE_OUTPUT, JSON.stringify(output))
      process.kill(process.pid, 'SIGTERM')
    }
  })
}
