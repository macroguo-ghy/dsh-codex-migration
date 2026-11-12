export const busyReason = '目标被 DSH 活跃 Agent 占用。关闭页面可能不会释放写锁；保存工作后可手动重启 DSH 再试。两边均新增的冲突不会因重启解决。'
export const isOwned = value => /owned|write handle|写.*占用|活跃 Agent 占用/i.test(String(value))
export function explainError(error) {
  if (isOwned(error.message)) return busyReason
  if (error instanceof SyntaxError) return '源记录或目标元数据不是有效 JSON，请检查来源位置并重新扫描'
  if (error.code === 'ENOENT') return '来源或目标文件已不存在，请确认路径并重新扫描（ENOENT）'
  if (['EACCES', 'EPERM'].includes(error.code)) return '无法访问来源或目标目录，请检查 DSH 进程的文件权限（' + error.code + '）'
  return error.message
}

// Diagnostics are shareable. Classify errors rather than copying arbitrary
// parser/backend exception text that may contain source bodies or credentials.
export function diagnosticReason(reason) {
  if (!reason) return undefined
  if (isOwned(reason)) return '目标写锁被占用；保存工作后等待释放或手动重启 DSH'
  if (/两边|双边/.test(reason)) return '源和目标均有新增，不能自动合并'
  if (/改写|截断|预览范围|前缀/.test(reason)) return '源历史与已确认前缀不一致，请重新扫描'
  if (/目录|路径|ENOENT/.test(reason)) return '工作目录或来源路径不可用，请核对 DSH 机器上的现有目录'
  if (/保真校验通过/.test(reason)) return '存储保真校验通过'
  if (/存储|记录与|校验|不一致/.test(reason)) return '存储一致性检查未通过，请检查本机任务详情'
  if (/父|子|历史未迁入/.test(reason)) return '父子历史不完整，按来源位置检查缺失成员'
  if (/权限|EACCES|EPERM/.test(reason)) return '文件访问权限不足'
  if (/无新增|没有可导入/.test(reason)) return '没有可导入的新轮次'
  return '请根据来源位置检查本机任务详情；诊断文件不包含原始异常正文'
}
