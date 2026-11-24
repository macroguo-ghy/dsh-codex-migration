// DSH owns language selection and fallback order. Keep user content verbatim.
let hostLocale
export function setUILocale(locale) { hostLocale = locale }
export function t(zh, en) { return hostLocale?.resolveText({ zh, en }) ?? zh }
export function formatDate(value) { return new Date(value).toLocaleString(hostLocale?.getLocale().active) }
