import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { WorkspaceAnalyzer, FaceModelEmitter, writePackageArtifacts } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url)
const staging = await mkdtemp(join(tmpdir(), 'dsh-migration-rpc-'))
try {
  await mkdir(join(staging, 'packages/plugin/src'), { recursive: true })
  await mkdir(join(staging, 'packages/protocol'), { recursive: true })
  await symlink(join(root, 'node_modules'), join(staging, 'node_modules'))
  // The public generator resolves TypeMeta identity through workspace package
  // declarations. Stage the published protocol declarations at build time only.
  const protocol = resolve(require.resolve('@deepseek-ai/dsh-typert-protocol'), '../types')
  await cp(protocol, join(staging, 'packages/protocol/src'), { recursive: true })
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  await writeFile(join(staging, 'packages/plugin/package.json'), JSON.stringify({ name: manifest.name, type: 'module', exports: { '.': './lib/index.js', './typert': manifest.exports['./typert'], './remote': manifest.exports['./remote'] } }))
  await writeFile(join(staging, 'packages/protocol/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-typert-protocol', type: 'module', exports: { '.': './src/index.d.ts', './types': './src/types.d.ts', './remote-info': './src/remote-info.d.ts' } }))
  await writeFile(join(staging, 'tsconfig.host.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2024', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: true,
    noEmit: true, types: [], baseUrl: '.', paths: { '@deepseek-ai/dsh-typert-protocol': ['packages/protocol/src/index.d.ts'] },
  }, files: [], references: [{ path: './packages/plugin' }, { path: './packages/protocol' }] }))
  for (const pkg of ['plugin', 'protocol']) await writeFile(join(staging, 'packages', pkg, 'tsconfig.json'), JSON.stringify({ extends: '../../tsconfig.host.json', compilerOptions: { composite: true }, include: ['src/**/*.ts'], references: [] }))
  const source = await readFile(join(root, 'controller/index.ts'), 'utf8')
  await writeFile(join(staging, 'packages/plugin/src/index.ts'), source)
  const model = new WorkspaceAnalyzer({ root: staging, packages: [manifest.name], faces: ['host'] }).analyze()
  if (!model.faces.length) throw new Error('未生成迁移 RPC')
  for (const face of model.faces) for (const pkg of face.packages) {
    const artifact = new FaceModelEmitter(face).emit(pkg.name)
    if (!artifact.remote) throw new Error('迁移 RPC 元数据缺失')
    writePackageArtifacts(root, [{ ...artifact, packageRoot: pkg.root }])
  }
  await mkdir(join(root, 'lib'), { recursive: true })
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  await writeFile(join(root, 'lib/controller.js'), '// @ts-nocheck -- generated TypeScript decorator helpers\n' + compiled.outputText)
} finally { await rm(staging, { recursive: true, force: true }) }
