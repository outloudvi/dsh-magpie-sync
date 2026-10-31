import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { runSync } from '../lib/sync.js'
import { formatSyncSummary, apply } from '../lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFile(resolve(root, path), 'utf8')

const levelsFromUpstream = [
  { effort: 'none' },
  { effort: 'low' },
  { effort: 'medium' },
  { effort: 'high' },
  { effort: 'xhigh' },
  { effort: 'max' },
  { effort: 'ultra' },
]

function makeContext(config) {
  const row = {
    entry: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' },
    override: structuredClone(config),
    inherited: {},
  }
  let edited
  return {
    context: {
      configEditor: {
        configuration: () => [row],
        edit: async (_entry, callback) => {
          edited = callback(row.override, row.inherited)
          row.override = edited
        },
      },
      credentials: { resolve: async () => undefined },
      settings: { describe() {} },
    },
    getConfig: () => row.override,
    getEdited: () => edited,
  }
}

async function withMockedFetch(body, callback) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://provider.example/v1/models')
    return { ok: true, json: async () => ({ data: body }) }
  }
  try {
    return await callback()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('模型页 slot 与客户端注入清单符合迁移要求', async () => {
  const client = await read('lib/client.js')
  const manifest = JSON.parse(await read('package.json'))
  const host = await read('lib/index.js')

  assert.match(
    client,
    /window\.__ModuleLoader__\.load\(\{\s+id: '@ovv\/dsh-magpie-sync'/,
  )
  assert.match(client, /ctx\.slots\.inject\('settings\.models\.footer'/)
  assert.match(
    client,
    /name: 'settings\.models\.footer',\s+id: 'dsh-magpie-sync',\s+order: 50/,
  )
  assert.doesNotMatch(client, /plugins\.bundle\.config|plugins\.row\.config/)
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-settings-models',
  ])
  assert.match(
    host,
    /ctx\.settings\.configure\(\{ auto: false \}, ctx\.fiber\)/,
  )
})

test('ultra 被过滤且卡片、同步备注解释 DSH Schema 限制', async () => {
  const client = await read('lib/client.js')
  const sync = await read('lib/sync.js')
  const context = makeContext({
    providers: {
      magpie: {
        baseURL: 'https://provider.example/v1',
        models: [{ id: 'm', reasoningEfforts: { off: null, low: 'low' } }],
      },
    },
  })
  const report = await withMockedFetch(
    [
      {
        id: 'm',
        reasoning: true,
        supported_reasoning_levels: levelsFromUpstream,
      },
    ],
    () => runSync(context.context, { provider: 'magpie', dryRun: true }),
  )

  assert.deepEqual(report.changes[0].skipped, ['ultra'])
  assert.match(client, /\/models 端点/)
  assert.match(client, /ultra 档位不受支持/)
  assert.match(client, /llm-pi-ai 的限制/)
  assert.match(
    sync,
    /THINKING_LEVELS\n \* 仅接受 off、minimal、low、medium、high、xhigh、max/,
  )
  assert.match(
    report.notes.join('\n'),
    /已跳过 DSH 不支持的 thinking level 级别 ultra/,
  )
  assert.match(
    report.notes.join('\n'),
    /仅支持 off、minimal、low、medium、high、xhigh、max 这 7 个级别/,
  )
  assert.match(sync, /会导致整个服务提供方配置校验失败/)
})

test('将 none 映射为 off:none，过滤 ultra，仅更新既有模型输入与档位', async () => {
  const originalModels = [
    {
      id: 'm',
      input: ['text'],
      reasoningEfforts: { off: null, low: 'existing-low' },
      custom: '保留',
    },
    {
      id: 'untouched',
      input: ['text'],
      reasoningEfforts: { medium: 'medium' },
    },
  ]
  const context = makeContext({
    providers: {
      magpie: {
        baseURL: 'https://provider.example/v1',
        models: originalModels,
      },
    },
  })

  await withMockedFetch(
    [
      {
        id: 'm',
        modalities: { input: ['text', 'image', 'audio'] },
        reasoning: true,
        supported_reasoning_levels: levelsFromUpstream,
      },
      {
        id: 'new-upstream-only',
        modalities: { input: ['image'] },
        reasoning_levels: ['low', 'high'],
      },
    ],
    async () => {
      const report = await runSync(context.context, {
        provider: 'magpie',
        dryRun: false,
        noneMapsToOff: true,
        syncModalities: true,
        syncReasoning: true,
      })
      assert.equal(report.ok, true)
      assert.equal(report.applied, true)
      assert.deepEqual(report.changes[0].toInput, ['text', 'image'])
      assert.deepEqual(report.changes[0].skipped, ['ultra'])
    },
  )

  const models = context.getConfig().providers.magpie.models
  assert.deepEqual(
    models.map((model) => model.id),
    ['m', 'untouched'],
  )
  assert.deepEqual(models[0].input, ['text', 'image'])
  assert.deepEqual(models[0].reasoningEfforts, {
    off: null,
    low: 'existing-low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  })
  assert.equal(models[0].custom, '保留')
  assert.deepEqual(models[1], originalModels[1])
})

test('同步摘要输出过滤原因与七档列表', () => {
  const summary = formatSyncSummary({
    ok: true,
    changes: [{ provider: 'magpie', model: 'm', skipped: ['ultra'] }],
    notes: ['已过滤 DSH Schema 不支持的档位: ultra'],
  })
  assert.match(summary, /已跳过 DSH 不支持的 thinking level 级别 ultra/)
  assert.match(
    summary,
    /仅支持 off、minimal、low、medium、high、xhigh、max 这 7 个级别/,
  )
  assert.match(summary, /已过滤 DSH Schema 不支持的档位: ultra/)
})

test('同步摘要使用新的「已是最新」文案', () => {
  const summary = formatSyncSummary({
    ok: true,
    changes: [],
    providers: [{ provider: 'magpie', models: 2 }],
  })
  assert.match(summary, /^已是最新。$/m)
  assert.match(summary, /magpie: 2 个已声明模型，元数据均已同步/)
})

test('插件保持关闭自动表单，且没有插件页重复卡片注册', async () => {
  const calls = []
  const ctx = {
    fiber: { entry: { options: { id: 'dsh-magpie-sync' } } },
    settings: { configure: (...args) => calls.push(args) },
    effect: (fn) => {
      fn()
    },
    inject: () => {},
    on: () => () => {},
  }
  apply(ctx, { targetProvider: 'magpie', syncTrigger: 0 })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { auto: false })
  const client = await read('lib/client.js')
  assert.doesNotMatch(client, /plugins\.bundle\.config|plugins\.row\.config/)
})

test('package declares the node test runner', async () => {
  const pkg = JSON.parse(await read('package.json'))
  assert.equal(pkg.scripts.test, 'node --test test/*.test.js')
})
