#!/usr/bin/env node
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { deleteVerified, describe, inventory } from './withdraw.js'

async function main() {
  const { values } = parseArgs({ options: {
    execute: { type: 'boolean' }, help: { type: 'boolean' }, 'dsh-home': { type: 'string' },
    root: { type: 'string' }, scope: { type: 'string' }, 'confirm-continued': { type: 'boolean' },
  } })
  if (values.help) {
    console.log('预览：dsh-codex-cleanup [--root 源ID]。停止 DSH 后，带 --root、--scope 和 --execute 永久删除该组；含续聊时另需 --confirm-continued。')
    return
  }
  const home = resolve(values['dsh-home'] ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  if (values.execute) {
    if (!values.root || !values.scope) throw new Error('请先预览，再指定 --root 和 --scope。')
    const result = await deleteVerified(home, { selection: [{ root: values.root, scope: values.scope }], confirmed: values['confirm-continued'] })
    console.log('已永久删除 ' + result.deleted.length + ' 条会话。')
    if (result.failures.length) throw new Error(result.failures.join('\n'))
    return
  }
  const { groups } = await inventory(home)
  console.log(JSON.stringify(groups.filter(g => !values.root || g.root === values.root).map(describe), null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
