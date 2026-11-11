// Read only loader declarations; never invoke an MCP client or connection.
export function configuredServers(ctx) {
  const names = new Set()
  if (typeof ctx.loader?.entries !== 'function') return { names, complete: false }
  let complete = true
  for (const entry of ctx.loader.entries()) {
    if (!/(?:^|\/)dsh-mcp-client$|^mcp-client$/.test(entry.options?.name ?? '')) continue
    const name = entry.options.config?.serverName
    if (typeof name === 'string') names.add(name)
    else complete = false
  }
  return { names, complete }
}

export function dependencies(source, inventory) {
  const found = new Map()
  for (const [index, { row, lineNumber }] of source.rows.entries()) {
    const p = row.payload
    const attributed = p.attributionMcpServer ?? p.attribution_mcp_server ?? p.server_name
    const namespace = p.type === 'function_call' ? /^mcp__([A-Za-z0-9_-]+?)__/.exec(p.name ?? '')?.[1] : undefined
    const name = typeof attributed === 'string' ? attributed : namespace
    if (!name) continue
    const prior = found.get(name)
    if (prior) prior.count++
    else found.set(name, { name, count: 1, line: lineNumber ?? index + 1,
      evidence: attributed ? '显式服务归因' : 'MCP工具命名空间',
      status: inventory.names.has(name) ? '已配置' : inventory.complete ? '未配置' : '未知' })
  }
  return [...found.values()]
}
