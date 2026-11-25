# Repository Guidelines

本插件将本机 Codex 历史导入 DeepSeek Harness（DSH），生成可继续对话的原生会话。开发环境使用 Node.js 22.15+，目标宿主为 DSH 0.2.2-rc.1。

## 项目结构

- `src/index.js` 注册宿主插件，`controller/index.ts` 定义迁移 RPC。`src/migration-service.js` 负责预览与提交，`src/tasks.js` 管理任务状态。
- 历史读取、对话归组、消息转换和写入分别位于 `src/source.js`、`src/groups.js`、`src/convert.js` 和 `src/import.js`。修改撤回范围或续聊确认逻辑时，查看 `src/withdraw.js`。
- 迁移面板及其样式位于 `src/migration-ui.js` 和 `src/migration-ui.css`。对话内的迁移报告使用 `src/client.js` 和 `src/client.css`。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `npm ci` | 按锁文件安装依赖 |
| `npm run typecheck` | 运行静态类型检查 |
| `node scripts/build-client.mjs` | 修改前端后重新生成 `src/client-bundle.js`，供客户端测试加载 |
| `npm test` | 运行完整测试；单独验证撤回逻辑可用 `node --test test/withdraw.test.js` |
| `npm pack` | 重新生成 RPC 和客户端产物，输出可安装的插件包 |

将生成的文件名传给 `dsh plugin --profile web add ./<文件名>.tgz`。首次启动 Web 使用 `dsh web`；本机若由 `dsh-start` 管理，更新插件后使用配套的 `dsh-restart`，再打开「Codex 迁移」验证。

## 迁移与恢复约定

- 重试时重新发现源文件、重复副本和会话归属，只对原任务失败或未完成的组加载历史、检查目标状态。重试预览独立于完整预览；返回全部对话时复用已有预览。相关回归见 `test/progressive-preview.test.js`。
- 仅在相同的冻结历史范围内复用轮次和哈希。若下一轮的开始事件标记上一轮中断，保留这个边界，排除下一轮正文。修改解析时用 `test/frozen-source.test.js` 核对旧任务恢复和源历史被改写的情况。
- 阶段提示保存在内存，成员检查点和组结果增量写入 SQLite，任务创建和结束时保存完整 JSON。修改持久化时用 `test/tasks.test.js` 验证进程被终止后能从检查点恢复。
- 性能对照使用同一份固定源数据和独立 DSH 目标目录，分别计时预览和导入。核对目标会话数量、归属、轮数和哈希后，再比较耗时、写入量和峰值内存。

## 前端与交互约定

通过宿主 slot 渲染页面。复用插件内的 `ui-controls.js` 和 `ui-locale.js`，颜色使用 `--dsw-alias-*`，列表排版参照 DSH 插件管理器。外部插件避免直接加载 Harness Client 控件包。详见 [DSH 外部插件 UI 规范](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.2-rc.1/packages/preset/agent-preset/skills/cordis-plugin-development/references/practices.md#L31-L36)。

导入按钮的数量须与实际提交范围一致。撤回按用户选中的对话计数；选中范围包含 DSH 续聊时集中提示一次，改变选择后重置确认。用合成对话验证全选、部分选中、取消选择和键盘操作。

## 编码、测试与提交

使用 ES 模块、两空格缩进、单引号和带扩展名的相对导入。多词文件名用小写连字符，函数用 camelCase，类用 PascalCase。

测试位于 `test/<功能>.test.js`，使用 `node:test`、`node:assert/strict` 和临时目录。按改动覆盖重复导入、中断恢复或部分失败。仓库未配置数值覆盖率门槛或独立 lint 命令。

每次提交聚焦一项逻辑变更，沿用 Conventional Commits，例如 `fix: improve withdrawal selection and migration controls`。PR 描述写明用户可见变化、关联 issue 和实际验证结果；面板改动附合成数据截图。
