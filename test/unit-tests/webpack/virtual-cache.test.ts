import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createUnplugin } from 'unplugin'
import { afterEach, describe, expect, it, vi } from 'vitest'
import webpack from 'webpack'

const virtualId = '~demo'
const virtualSource = 'export default "virtual-ok"\n'

function createPlugin(resolveId: (id: string) => string | undefined) {
  return createUnplugin(() => ({
    name: 'virtual-cache-test',
    resolveId,
    load(id) {
      if (id === virtualId)
        return virtualSource
    },
  })).webpack()
}

function runWebpack(context: string, plugins: webpack.WebpackPluginInstance[]) {
  return new Promise<void>((done, reject) => {
    const compiler = webpack({
      mode: 'development',
      context,
      entry: resolve(context, 'entry.js'),
      output: {
        path: resolve(context, 'dist'),
        filename: 'main.js',
      },
      plugins,
    })
    compiler.run((error, stats) => {
      compiler.close(() => {
        if (error)
          reject(error)
        else if (stats?.hasErrors())
          reject(new Error(stats.toString({ errors: true, errorDetails: true })))
        else
          done()
      })
    })
  })
}

// Mirrors webpack's resolver cache: the cached request is already the virtual
// path, so resolveId does not run, and the in-memory file is gone.
function cachedResolvePlugin(): webpack.WebpackPluginInstance {
  return {
    apply(compiler) {
      compiler.resolverFactory.hooks.resolver.for('normal').tap('cached-virtual-resolve', (resolver) => {
        resolver.hooks.resolve.tapAsync({ name: 'cached-virtual-resolve', stage: -200 }, (request, _context, callback) => {
          if (request.request !== virtualId)
            return callback()
          const file = resolve(compiler.options.context ?? '', '_virtual_') + encodeURIComponent(virtualId)
          callback(null, {
            ...request,
            request: undefined,
            path: file,
            relativePath: file,
          })
        })
      })
    },
  }
}

describe('webpack virtual module cache', () => {
  const contexts: string[] = []

  afterEach(() => {
    for (const context of contexts)
      rmSync(context, { recursive: true, force: true })
    contexts.length = 0
  })

  function createContext() {
    const context = resolve(tmpdir(), `unplugin-virtual-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(context, { recursive: true })
    writeFileSync(resolve(context, 'entry.js'), `import value from '${virtualId}'\nexport default value\n`)
    contexts.push(context)
    return context
  }

  it('loads a virtual module', async () => {
    const context = createContext()
    const resolveId = vi.fn((id: string) => id === virtualId ? virtualId : undefined)
    await runWebpack(context, [createPlugin(resolveId)])
    expect(resolveId).toHaveBeenCalled()
    expect(readFileSync(resolve(context, 'dist/main.js'), 'utf8')).toContain('virtual-ok')
  })

  it('recreates the virtual file when webpack resolves it from cache', async () => {
    const context = createContext()
    const resolveId = vi.fn((id: string) => id === virtualId ? virtualId : undefined)
    await runWebpack(context, [cachedResolvePlugin(), createPlugin(resolveId)])
    expect(resolveId.mock.calls.map(call => call[0])).not.toContain(virtualId)
    expect(readFileSync(resolve(context, 'dist/main.js'), 'utf8')).toContain('virtual-ok')
  })

  it('does not overwrite an on-disk file that shares the _virtual_ prefix', async () => {
    const context = createContext()
    writeFileSync(resolve(context, '_virtual_helper.js'), 'export default "real-file-ok"\n')
    writeFileSync(
      resolve(context, 'entry.js'),
      `import virtual from '${virtualId}'\nimport real from './_virtual_helper.js'\nexport default { virtual, real }\n`,
    )
    const resolveId = vi.fn((id: string) => id === virtualId ? virtualId : undefined)
    await runWebpack(context, [createPlugin(resolveId)])
    const bundle = readFileSync(resolve(context, 'dist/main.js'), 'utf8')
    expect(bundle).toContain('virtual-ok')
    expect(bundle).toContain('real-file-ok')
  })
})
