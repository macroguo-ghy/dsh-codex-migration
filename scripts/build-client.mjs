import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
const result = await build({ entryPoints: [new URL('../src/browser.js', import.meta.url).pathname], bundle: true,
  write: false, format: 'cjs', platform: 'browser', target: 'es2022', loader: { '.css': 'text' },
  external: ['react'], legalComments: 'none', minify: true })
const bundle = '// @ts-nocheck -- generated browser bundle\nwindow.__ModuleLoader__.load({id:"dsh-codex-migration",factory:require=>{const module={exports:{}};const exports=module.exports;\n'
  + result.outputFiles[0].text + '\nreturn module.exports}})\n'
await writeFile(new URL('../src/client-bundle.js', import.meta.url), bundle)
