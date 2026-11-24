const opening = '<oai-mem-citation>'
const footer = /^<oai-mem-citation>\s*<citation_entries>[\s\S]*?<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>\s*$/

// Codex can split one assistant message across several output text blocks.
export function withoutMemoryCitation(content) {
  if (typeof content === 'string') {
    const start = content.lastIndexOf(opening)
    return start >= 0 && footer.test(content.slice(start)) ? content.slice(0, start).trimEnd() : content
  }
  if (!Array.isArray(content)) return content
  let start = content.length
  while (start && ['output_text', 'text'].includes(content[start - 1]?.type) && typeof content[start - 1].text === 'string') start--
  const tail = content.slice(start)
  const joined = tail.map(block => block.text).join('')
  const clean = withoutMemoryCitation(joined)
  if (clean === joined) return content
  const result = content.slice(0, start)
  let remaining = clean.length
  for (const block of tail) {
    if (!remaining) break
    result.push({ ...block, text: block.text.slice(0, remaining) })
    remaining -= Math.min(remaining, block.text.length)
  }
  return result
}
