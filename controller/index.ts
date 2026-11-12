import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** Authenticated migration operations, independent of conversational Agents. */
export class CodexMigration extends TypertRemoteService {
  static inject = ['typert']
  dispatch: (input: unknown) => Promise<unknown>
  constructor(ctx: Context, config: { dispatch: (input: unknown) => Promise<unknown> }) {
    super(ctx, 'codexMigration')
    this.dispatch = config.dispatch
  }
  /** Submit or inspect a migration operation through the host Gateway. */
  @Remote
  async request(input: string): Promise<string> {
    try {
      if (input.length > 1_000_000) throw new Error('迁移请求过大')
      const request = JSON.parse(input)
      if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('无效迁移请求')
      return JSON.stringify({ ok: true, value: await this.dispatch(request) })
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof SyntaxError ? '无效 JSON 请求' : error instanceof Error ? error.message : '迁移操作失败' })
    }
  }
}
