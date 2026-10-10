// 构建脚本：等价于 yakumo 对单个插件的构建流程
//   1) tsc   -> 产出 lib/*.d.ts（类型声明，emitDeclarationOnly）
//   2) esbuild -> 打包 lib/index.js（CJS，依赖走 external 不内联）
// 用法：node external/vatsim-search/build.js
const path = require('path')
const { execFileSync } = require('child_process')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..', '..')

function runTsc() {
  execFileSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', path.join(__dirname, 'tsconfig.json'),
  ], { stdio: 'inherit' })
}

async function runEsbuild() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'index.ts')],
    outfile: path.join(__dirname, 'lib', 'index.js'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    logLevel: 'warning',
    external: ['koishi', 'axios', 'cordis', '@satorijs/*', '@koishijs/*', '@shangxueink/*'],
  })
}

;(async () => {
  try {
    runTsc()
    await runEsbuild()
    console.log('vatsim-search BUILD OK -> external/vatsim-search/lib/index.js')
  } catch (e) {
    console.error('vatsim-search BUILD FAILED')
    console.error(e.message || e)
    process.exit(1)
  }
})()
