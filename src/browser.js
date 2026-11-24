import contribution from '../lib/typert.remote-client.js'
import { apply as conversation, inject as conversationInject } from './client.js'
import { applyMigrationUI } from './migration-ui.js'

export const inject = ['remote']
export async function apply(ctx) {
  await ctx.remote.$mount(contribution)
  ctx.plugin({ inject: conversationInject, apply: conversation })
  ctx.plugin({ inject: ['slots', 'locale', 'remote', 'remote.codexMigration', 'layout', 'uiWorkspace'], apply: applyMigrationUI })
}
