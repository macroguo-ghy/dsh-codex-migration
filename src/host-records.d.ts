import '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:codex-migration/report': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/request-budget': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/context-prepare': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/context-choice': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/summary-block': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/summary-commit': import('@deepseek-ai/dsh-util-values').JsonValue
    'plugin:codex-migration/summary-committed': import('@deepseek-ai/dsh-util-values').JsonValue
  }
}
