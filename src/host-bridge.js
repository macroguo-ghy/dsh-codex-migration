// The pinned host supplies its own append function, preserving Session class
// identity instead of loading a second copy of the host runtime as a dependency.
let writer
export function setRecordWriter(append) { writer = append }
export function publishReport(session, data) {
  if (!writer) return false
  writer(session, 'plugin:codex-migration/report', JSON.parse(JSON.stringify(data)))
  return true
}
