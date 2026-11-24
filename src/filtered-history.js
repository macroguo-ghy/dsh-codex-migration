// A native range replacement keeps the transcript readable without a plugin
// interpreter. Its source sequences also retain the exact roles for summaries.
export function filteredHistoryMessage(session, seq) {
  const message = session.deriveEventMessage(session.eventAt(seq))
  if (!message || message.role === 'tool') return null
  if (message.role !== 'assistant') return message
  const content = message.content.filter(block => block.type !== 'tool-call')
  return content.length ? { ...message, content } : null
}

export function isFilteredHistory(event) {
  return event.type === 'user/message' && event.data.source?.kind === 'codex-imported-context'
    && event.data.id.startsWith('codex-filtered-history-') && event.surfaceOp?.op === 'replace'
}

export function quoteHistory(session, seqs) {
  const content = [], lines = []
  function flush() {
    if (lines.length) content.push({ type: 'text', text: lines.join('\n') })
    lines.length = 0
  }
  for (const seq of seqs) {
    const message = filteredHistoryMessage(session, seq)
    if (!message?.content.length) continue
    lines.push('[Codex 历史原文 · ' + message.role + ' · ' + message.source.kind + ' · seq ' + seq + ']')
    for (const block of message.content) {
      if (block.type === 'text' || block.type === 'reasoning') lines.push(block.text)
      else { flush(); content.push(block) }
    }
  }
  flush()
  return content
}
