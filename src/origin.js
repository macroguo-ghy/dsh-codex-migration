// A role describes how a message is delivered, not who supplied each part.
const forms = new Map([
  ['environment_context', 'snapshot'], ['recommended_plugins', 'catalog'],
  ['skills_instructions', 'catalog'], ['skill', 'instructions'], ['skills', 'instructions'], ['agents_md', 'instructions'],
  ['user_instructions', 'instructions'], ['developer_instructions', 'instructions'],
  ['system-reminder', 'notice'], ['tools', 'catalog'], ['plugins_instructions', 'catalog'],
  ['permissions instructions', 'instructions'], ['collaboration_mode', 'snapshot'],
  ['multi_agent_role', 'instructions'], ['multi_agent_mode', 'instructions'],
  ['app-context', 'snapshot'], ['tool_instructions', 'instructions'],
])
const sourceForms = { skills: 'instructions', agents_md: 'instructions', harness: 'snapshot',
  developer_instructions: 'instructions', tool: 'notice' }

export const submittedText = parts => Array.isArray(parts)
  ? parts.filter(block => typeof block?.text === 'string').map(block => block.text).join('\n') : String(parts ?? '')

export function submissions(rows) {
  const remaining = new Map()
  for (const { row } of rows) {
    if (row.type !== 'event_msg') continue
    const p = row.payload
    const value = p.type === 'user_message' ? p.message
      : p.type === 'item_completed' && p.item?.type === 'UserMessage' ? submittedText(p.item.content) : undefined
    if (typeof value === 'string') remaining.set(value, (remaining.get(value) ?? 0) + 1)
  }
  return { claim(parts) {
    const value = submittedText(parts), count = remaining.get(value) ?? 0
    if (count) remaining.set(value, count - 1)
    return count > 0
  } }
}

export function classifyParts(payload, evidence) {
  const parts = Array.isArray(payload.content) ? payload.content : []
  const submitted = evidence?.claim(parts) ?? false
  const meta = payload.internal_chat_message_metadata_passthrough
  return parts.map((block, index) => {
    const source = meta?.content_item_metadata?.[index]?.provenance
    const type = typeof source === 'object' && source !== null ? source.type : undefined
    if (type === 'user') return { block, origin: 'user', evidence: 'provenance' }
    if (Object.hasOwn(sourceForms, type)) return { block, origin: type, form: sourceForms[type], evidence: 'provenance' }
    const kind = meta?.content_item_kinds?.[index]
    if (typeof kind === 'string' && forms.has(kind)) {
      return { block, origin: kind, form: forms.get(kind), evidence: 'content-kind' }
    }
    const value = block?.text?.trim?.() ?? ''
    if (/^<codex_delegation(?:\s[^>]*|)>/.test(value) && value.endsWith('</codex_delegation>')
      && value.includes('<source_thread_id>') && value.includes('<input>')) {
      return { block, origin: 'delegation', form: 'relay', evidence: 'delegation-envelope' }
    }
    if (payload.role === 'developer' || payload.role === 'system') {
      return { block, origin: payload.role, form: 'instructions', evidence: 'role' }
    }
    // A submission matches the complete record, not each unannotated part.
    // Keep ambiguous mixed records and pasted instruction envelopes visible.
    if (submitted && parts.length > 1) return { block, origin: 'unknown', evidence: 'mixed-submission' }
    if (/^# AGENTS\.md instructions(?: for |\s|$)/.test(value)
      && value.includes('<INSTRUCTIONS>') && value.endsWith('</INSTRUCTIONS>')) {
      return submitted ? { block, origin: 'unknown', evidence: 'ambiguous-submission' }
        : { block, origin: 'agents_md', form: 'instructions', evidence: 'known-envelope' }
    }
    const tag = value.startsWith('<permissions instructions>') ? 'permissions instructions'
      : /^<([\w-]+)(?:\s[^>]*|)>/.exec(value)?.[1]
    if (tag && forms.has(tag) && value.endsWith('</' + tag + '>')) {
      return submitted ? { block, origin: 'unknown', evidence: 'ambiguous-submission' }
        : { block, origin: tag, form: forms.get(tag), evidence: 'known-envelope' }
    }
    if (submitted && parts.length === 1 && typeof block.text === 'string') return { block, origin: 'user', evidence: 'single-part-submission' }
    return { block, origin: 'unknown', evidence: 'unknown' }
  })
}
