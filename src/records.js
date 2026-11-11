import { appendPluginRecord } from '@deepseek-ai/dsh-session'

export function publishReport(session, data) {
  appendPluginRecord(session, 'plugin:codex-migration/report', JSON.parse(JSON.stringify(data)))
  return true
}
