const labels = {
  'silent-context': '静默上下文', 'unknown-source': '来源未确定',
  'reasoning-summary': '加密推理有可读摘要', 'reasoning-missing': '加密推理无可读摘要',
  'attachment-missing': '附件不可迁移', 'unsupported-content': '不支持的内容',
  'unpaired-tool': '未配对工具轨迹', 'usage-unmapped': '用量无法映射', 'metadata-unmapped': '元数据无法映射',
  'compaction-summary': '压缩有可读摘要', 'compaction-missing': '压缩无可读摘要',
}

export class MigrationReport extends Set {
  constructor(path) { super(); this.path = path; this.items = []; this.position = {} }
  at(position) { this.position = position }
  note(category, message, details = {}) {
    this.items.push({ category, message, source: this.path, ...this.position, ...details })
    return this
  }
  add(message) {
    super.add(message)
    const category = message.startsWith('附件') ? 'attachment-missing'
      : /工具调用|工具结果/.test(message) ? 'unpaired-tool'
      : /token/.test(message) ? 'usage-unmapped'
      : /注释元数据/.test(message) ? 'metadata-unmapped' : 'unsupported-content'
    return this.note(category, message)
  }
  toJSON() {
    const counts = new Map()
    for (const item of this.items) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    return { counts: Object.fromEntries(counts), summary: [...counts].map(([category, count]) => ({
      category, label: labels[category] ?? '缺失或降级', count,
      unit: ['silent-context', 'unknown-source'].includes(category) ? '个内容块' : '条源记录',
    })), items: this.items }
  }
}

export function reportText(report) {
  if (!report) return []
  const lines = report.summary.map(item => item.label + ' ' + item.count + ' ' + item.unit)
  // Detailed records are returned separately for the native expandable view.
  for (const item of report.items.slice(0, 12)) {
    lines.push('  源行 ' + (item.line ?? '?') + (item.block === undefined ? '' : ' · 块 ' + (item.block + 1)) + '：' + item.message)
  }
  if (report.items.length > 12) lines.push('  另有 ' + (report.items.length - 12) + ' 条定位记录，展开迁移详情查看。')
  return lines
}
