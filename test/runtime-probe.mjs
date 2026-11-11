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
        })
        output.result = (await ctx.commands.execute(driver.agent, input.command, [], AbortSignal.timeout(60_000)))?.result
      }
      if (input.resume) {
        const requests = []
        adapter = ctx.llm.registerAdapter(['migration-probe'], {
          providerInfo: id => ({ id, name: id }),
          providerRetryPolicy: () => undefined,
          imageRequestPricing: () => undefined,
          imageRequestTarget: (_provider, _model, image) => ({ width: image.width, height: image.height, maxBytes: image.bytes }),
          listModels: async () => [],
          async resolveModel(provider, model) {
            return { provider, id: model, name: model, context: { contextWindow: 100_000 }, inputModalities: ['text', 'image'] }
          },
          async prepareCall(provider, model) {
            return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) }
          },
          async *stream(options) {
            if (options.purpose === undefined) requests.push(options.messages)
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'native continuation answer' } }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        })
        resumed = await ctx.agents.resume({ resumeSessionId: input.resume,
          agentOptions: { provider: 'migration-probe', model: 'fixture' } })
        resumed.agent.followup({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: 'native continuation prompt' }],
          source: { kind: 'user' } })
        await resumed.agent.whenIdle()
        output.requests = requests
        await resumed.dispose()
        resumed = undefined
      }
      const controller = ctx.get('sessionController')
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
