import { readFile, writeFile } from 'node:fs/promises'

// The DSH browser module table supplies React and its UI primitives. This entry needs no
// transpilation or bundled dependencies, only the host's closure factory.
const source = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/client.css', import.meta.url), 'utf8')
const body = source.replace("import { createElement as h, useState } from 'react'",
  "const { createElement: h, useState } = require('react')")
  .replace("import { DisclosureRow, Button, IconContextInjectionOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'",
    "const { DisclosureRow, Button, IconContextInjectionOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')")
  .replace("import styles from './client.css'", 'const styles = ' + JSON.stringify(styles))
  .replace(/^export /gm, '')
const bundle = 'window.__ModuleLoader__.load({\n  id: "dsh-codex-migration",\n  factory: require => {\n'
  + body.split('\n').map(line => line ? '    ' + line : '').join('\n')
  + '\n    return { apply, inject }\n  }\n})\n'
await writeFile(new URL('../src/client-bundle.js', import.meta.url), bundle)
