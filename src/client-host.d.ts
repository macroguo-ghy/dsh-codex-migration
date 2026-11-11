// DSH resolves these browser modules through its runtime module table. Their
// implementation and integration are verified against the pinned native host.
declare module '*.css' { const css: string; export default css }
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export const DisclosureRow: import('react').ComponentType<any>
  export const Button: import('react').ComponentType<any>
  export const IconContextInjectionOutlineRegular: import('react').ComponentType<any>
}
interface Window { __ModuleLoader__: { load(bundle: { id: string; factory: (require: (name: string) => any) => any }): void } }
