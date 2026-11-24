import { classifyParts, submissions } from './origin.js'
import { withoutMemoryCitation } from './memory-citation.js'
import { splitTurns } from './source.js'

export function conversationPreview(source) {
  const evidence = submissions(source.rows)
  let first, latest, reply
  for (const turn of splitTurns(source).turns) {
    const hasUser = turn.rows.some(({ row }) => row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'user')
    const hasReply = turn.rows.some(({ row }) => row.type === 'response_item' && row.payload.type === 'message' && row.payload.role === 'assistant' && row.payload.phase !== 'commentary')
    for (const { row, lineNumber } of turn.rows) {
      const p = row.payload
      let text, role
      if (row.type === 'response_item' && p.type === 'message' && p.role === 'user') {
        role = 'user'
        text = classifyParts(p, evidence).filter(part => !part.form).map(part => part.block.text).filter(Boolean).join('\n')
      } else if (row.type === 'response_item' && p.type === 'message' && p.role === 'assistant' && p.phase !== 'commentary') {
        role = 'assistant'
        const clean = withoutMemoryCitation(p.content)
        text = typeof clean === 'string' ? clean : clean?.filter(part => ['output_text', 'text'].includes(part.type)).map(part => part.text).join('\n')
      } else if (row.type === 'event_msg' && ((!hasUser && p.type === 'user_message') || (!hasReply && p.type === 'agent_message' && p.phase !== 'commentary'))) {
        role = p.type === 'user_message' ? 'user' : 'assistant'
        text = role === 'assistant' ? withoutMemoryCitation(p.message) : p.message
      }
      if (typeof text !== 'string' || !text.trim()) continue
      const message = { line: lineNumber, text }
      if (role === 'user') { first ??= message; latest = message }
      else reply = message
    }
  }
  return [first && { ...first, label: '首次提问' }, latest && latest.text !== first?.text && { ...latest, label: '最近提问' },
    reply && { ...reply, label: '最后回复' }].filter(Boolean).sort((a, b) => a.line - b.line)
}
