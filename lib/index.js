/**
 * dsh-magpie-sync 服务端代码。
 *
 * 通过本机回环请求或易失配置触发同步，并将结果返回模型配置页操作卡片。
 * 仅更新所选服务提供方中既有模型的 `input` 与 `reasoningEfforts`，不增删模型。
 */

import { runSync } from './sync.js'

export const name = 'dsh-magpie-sync'
export const inject = ['configEditor', 'credentials', 'settings']

const BRIDGE_PATH = '/api/dsh-magpie-sync/run'
const MAX_JSON_BODY_BYTES = 16 * 1024

let zInstance
try {
  const mod = await import('@deepseek-ai/schemastery')
  zInstance = mod.default || mod
} catch {}

export const Config = zInstance
  ? zInstance.object({
      targetProvider: zInstance.string().default('magpie').volatile(),
      syncTrigger: zInstance.number().default(0).volatile(),
      lastStatus: zInstance.string().default('idle').volatile(),
      lastResult: zInstance.string().default('').volatile(),
    })
  : undefined

function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress
  if (
    address !== '127.0.0.1' &&
    address !== '::1' &&
    address !== '::ffff:127.0.0.1'
  )
    return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  return true
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(body))
}

export function formatSyncSummary(report) {
  if (!report?.ok) {
    return `同步失败：${report?.error ?? '未知错误'}`
  }
  const changes = report.changes ?? []
  const lines = []
  if (!changes.length) {
    lines.push('已是最新。')
    for (const p of report.providers ?? []) {
      lines.push(
        `  ${p.provider}: ${p.error ?? `${p.models ?? 0} 个已声明模型，元数据均已同步`}`,
      )
    }
  } else {
    lines.push(`已更新 ${changes.length} 个现有模型的元数据：`)
    for (const c of changes) {
      const prefix = `  ${c.provider ? `${c.provider} / ` : ''}${c.model}:`
      if (c.toInput) {
        const fi = (c.fromInput ?? ['text']).join(',')
        const ti = c.toInput.join(',')
        lines.push(`${prefix} input [${fi}] -> [${ti}]`)
      }
      if (c.toEfforts) {
        const pairs = Object.entries(c.toEfforts)
          .map(([k, v]) => `${k}:${v}`)
          .join(', ')
        const from = (c.from ?? []).join(',') || '(无)'
        lines.push(`${prefix} reasoningEfforts ${from} -> { ${pairs} }`)
      }
      if (c.skipped?.length) {
        lines.push(
          `      已跳过 DSH 不支持的 thinking level 级别 ${c.skipped.join('、')}：DSH 的 llm-pi-ai 仅支持 off、minimal、low、medium、high、xhigh、max 这 7 个级别。`,
        )
      }
    }
  }
  for (const n of report.notes ?? []) {
    lines.push(`  注: ${n}`)
  }
  return lines.join('\n')
}

function readVolatile(ref, fallback) {
  if (
    ref !== null &&
    typeof ref === 'object' &&
    typeof ref.get === 'function'
  ) {
    return ref.get()
  }
  return ref ?? fallback
}

export function apply(ctx, config) {
  const entryId = ctx.fiber?.entry?.options?.id ?? 'dsh-magpie-sync'

  // 禁用插件页自动生成的 Schema 表单，专用同步卡片仅显示在模型配置页底部。
  ctx.effect(
    () => ctx.settings.configure({ auto: false }, ctx.fiber),
    'dsh-magpie-sync：禁用自动生成的设置表单',
  )

  let running = false

  const executeSync = async (rawProvider) => {
    const trimmed = String(rawProvider ?? '').trim()
    const wantProvider = trimmed && trimmed !== '*' ? trimmed : undefined
    const report = await runSync(ctx, {
      provider: wantProvider,
      dryRun: false,
      noneMapsToOff: true,
      syncModalities: true,
      syncReasoning: true,
    })
    const summary = formatSyncSummary(report)
    return { ok: Boolean(report.ok), summary, report }
  }

  // 1. 模型配置页按钮使用的本机回环 HTTP 快捷通道
  ctx.inject(['webServer'], (wctx) => {
    wctx.effect(() => {
      const dispose = wctx.webServer.register({
        kind: 'exact',
        path: BRIDGE_PATH,
        handler: async (req, res) => {
          if (!isLoopbackRequest(req)) {
            writeJson(res, 403, {
              ok: false,
              summary: '请通过 localhost 访问',
            })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, { ok: false, summary: 'HTTP 方法不受支持' })
            return
          }
          if (running) {
            writeJson(res, 409, {
              ok: false,
              summary: '同步正在进行中……',
            })
            return
          }
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { ok: false, summary: '请求参数格式无效' })
            return
          }
          running = true
          try {
            const result = await executeSync(
              body.provider ?? readVolatile(config?.targetProvider, 'magpie'),
            )
            writeJson(res, 200, result)
          } catch (error) {
            writeJson(res, 500, {
              ok: false,
              summary: `同步异常：${String(error?.message ?? error)}`,
            })
          } finally {
            running = false
          }
        },
      })
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'dsh-magpie-sync：Web 本机回环接口')
  })

  // 备用方式：监听易失字段 `syncTrigger` 的变更
  let lastHandledTrigger = Number(readVolatile(config?.syncTrigger, 0)) || 0

  const deferWrite = (fn) => {
    setTimeout(() => {
      void Promise.resolve()
        .then(fn)
        .catch((err) => {
          ctx.logger?.warn?.('dsh-magpie-sync：延迟写入失败：', err)
        })
    }, 20)
  }

  const checkAndRun = () => {
    const currentTrigger = Number(readVolatile(config?.syncTrigger, 0)) || 0
    if (currentTrigger <= 0 || currentTrigger === lastHandledTrigger || running)
      return
    lastHandledTrigger = currentTrigger
    running = true

    const rawProvider = String(
      readVolatile(config?.targetProvider, 'magpie') ?? '',
    ).trim()

    deferWrite(async () => {
      try {
        const { ok, summary } = await executeSync(rawProvider)
        await ctx.settings.update(entryId, {
          lastStatus: ok ? 'done' : 'error',
          lastResult: summary,
        })
      } catch (error) {
        try {
          await ctx.settings.update(entryId, {
            lastStatus: 'error',
            lastResult: `同步失败：${String(error?.message ?? error)}`,
          })
        } catch {}
      } finally {
        running = false
      }
    })
  }

  ctx.effect(() => {
    const dispose = ctx.on('loader/volatile-update', () => {
      checkAndRun()
    })
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-magpie-sync：触发监听器')
}
