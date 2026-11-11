// Compatibility entry point for the shipped DSH 0.2.2-rc.1 host. Install
// request-boundary hooks in memory. The installed DSH files are never edited.
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function once(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Codex continuation: incompatible DSH host hook')
  return source.replace(anchor, replacement)
}

function agentLoop(source) {
  source = once(source, 'import { SessionLogOffset,', 'import { appendPluginRecord, SessionLogOffset,')
  source = once(source,
    'throw new LlmError(finish.failure.message, finish.failure.code, finish.failure);',
    `throw new LlmError(
      finish.failure.code === "CONTEXT_WINDOW_EXCEEDED" && this.loopCtx.bail("codex-migration/owns-continuation", this.session)
        ? "模型服务拒绝了续聊请求，已超出上下文窗口。请切换到上下文窗口更大的模型。"
        : finish.failure.message,
      finish.failure.code, finish.failure
    );`)
  source = once(source, 'preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal);', `preparedCall = await this.loopCtx.llm.prepareCall(proposedConfig, signal, (controls, info) => {
    const limit = this.loopCtx.bail("codex-migration/default-output-limit", this.session);
    return controls.maxTokens === undefined && info.defaultMaxTokens > limit
      ? { ...controls, maxTokens: limit } : controls;
  });`)
  const anchor = 'const request = this.buildRequest(config, preparedCall, assembly.tools, {'
  source = once(source, anchor, anchor.replace('const request', 'const originalRequest'))
  return once(source, '}, startsRequestSeries, signal);\n\t\t\tconst live = new AssistantStreamAttempt',
    `}, startsRequestSeries, signal);
    const selectedRequest = this.loopCtx.bail("codex-migration/continuation-request", {
      session: this.session, request: originalRequest, window: preparedCall?.context?.contextWindow, configuration: preparedCall?.config,
      record: data => appendPluginRecord(this.session, "plugin:codex-migration/request-budget", data)
    });
    const request = selectedRequest === undefined ? originalRequest : markAgentLoopRequest(deepFreeze(selectedRequest));
    const live = new AssistantStreamAttempt`)
}

function compaction(source) {
  const skip = 'ctx.bail("codex-migration/owns-continuation", agent.session)'
  for (const [event, fields, fallback] of [
    ['agent/pre-step', 'agent, signal', 'return next();'],
    ['agent/request', 'agent, signal', 'return next();'],
    ['agent/request-error', 'agent, failure, signal', 'return next();'],
  ]) {
    const anchor = `ctx.on("${event}", async ({ ${fields} }, next) => {`
    source = once(source, anchor, anchor + `\n if (${skip}) ${fallback}`)
  }
  return source
}

registerHooks({
  load(url, context, nextLoad) {
    const match = /\/(dsh-agent-loop|dsh-compaction-basic|dsh-session)\/lib\/index\.js$/.exec(url)
    if (!match || !url.startsWith('file:')) return nextLoad(url, context)
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', url)), 'utf8'))
    if (pkg.version !== '0.2.2-rc.1' || pkg.name !== '@deepseek-ai/' + match[1]) {
      throw new Error('Codex continuation requires DSH 0.2.2-rc.1')
    }
    const loaded = nextLoad(url, context)
    const source = typeof loaded.source === 'string' ? loaded.source
      : ArrayBuffer.isView(loaded.source)
        ? Buffer.from(loaded.source.buffer, loaded.source.byteOffset, loaded.source.byteLength).toString('utf8')
        : Buffer.from(loaded.source).toString('utf8')
    if (match[1] === 'dsh-session') {
      const bridge = JSON.stringify(new URL('./host-bridge.js', import.meta.url).href)
      return { ...loaded, source: source + '\nimport { setRecordWriter } from ' + bridge + ';\nsetRecordWriter(appendPluginRecord);\n' }
    }
    return { ...loaded, source: match[1] === 'dsh-agent-loop' ? agentLoop(source) : compaction(source) }
  },
})
