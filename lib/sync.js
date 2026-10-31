/**
 * dsh-magpie-sync 核心同步逻辑：读取 Magpie 风格 `/v1/models` 元数据。
 *
 * 同步 `modalities.input`（或 `input_modalities`）到 `input`，并同步
 * `supported_reasoning_levels`（或 `reasoning_levels`）到 `reasoningEfforts`。
 * 支持 `none` 到 `off: "none"` 的映射，并自动过滤 DSH 内置 `llm-pi-ai`
 * 思考强度 Schema 不支持的档位（如 `ultra`）。llm-pi-ai 的 THINKING_LEVELS
 * 仅接受 off、minimal、low、medium、high、xhigh、max 七个固定值；写入其他值会导致整个服务提供方配置校验失败。过滤项记录在 `skipped`。
 */

/** DSH 思考档位的标准词汇，按强度递增排列。 */
export const LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

/** DSH 输入模态的标准词汇。 */
export const MODALITIES = ['text', 'image']

/** 本同步逻辑支持的服务提供方适配器。 */
export const ADAPTERS = [
  { packageName: '@deepseek-ai/dsh-llm-pi-ai', entryIds: ['llm-pi-ai'] },
]

/** 合并条目的继承配置与显式覆盖配置，覆盖配置优先。 */
export function mergeLayers(current, inherited) {
  const out = { ...(inherited ?? {}) }
  for (const [k, v] of Object.entries(current ?? {})) out[k] = v
  return out
}

/** 每个加载器条目生成一行诊断信息，用于匹配失败时排查。 */
export function describeEntries(rows) {
  return rows.slice(0, 60).map((row) => {
    const entry = row?.entry ?? {}
    const effective = mergeLayers(row?.override, row?.inherited)
    const providers = effective?.providers
    const keys =
      providers && typeof providers === 'object'
        ? Object.keys(providers).join('/')
        : ''
    return `id=${String(entry.id ?? '')} name=${String(entry.name ?? '')} providers=[${keys}]`
  })
}

/** 查找本同步逻辑可以修改的 llm-pi-ai 适配器条目。 */
export function findEntry(rows) {
  let best
  for (const row of rows) {
    const entry = row?.entry ?? {}
    const id = String(entry.id ?? '')
    const name = String(entry.name ?? '')
    const effective = mergeLayers(row?.override, row?.inherited)
    const hasProviders = Boolean(
      effective?.providers && typeof effective.providers === 'object',
    )
    const hasModels = Boolean(
      hasProviders &&
      Object.values(effective.providers).some(
        (p) => Array.isArray(p?.models) && p.models.length,
      ),
    )

    let score = 0
    if (ADAPTERS.some((a) => a.packageName === name || a.entryIds.includes(id)))
      score += 100
    else if (
      ADAPTERS.some(
        (a) => name.includes(a.packageName) || id.includes(a.entryIds[0]),
      )
    )
      score += 80
    if (hasProviders) score += 30
    if (hasModels) score += 40

    if (score > 0 && (!best || score > best.score)) best = { row, score }
  }
  return best?.row
}

/** 从 `modalities.input` 或 `input_modalities` 解析输入模态。 */
export function upstreamInputModalities(row) {
  const raw = Array.isArray(row?.modalities?.input)
    ? row.modalities.input
    : Array.isArray(row?.input_modalities)
      ? row.input_modalities
      : Array.isArray(row?.inputModalities)
        ? row.inputModalities
        : undefined
  if (!raw) return undefined
  const filtered = [
    ...new Set(
      raw.filter((m) => typeof m === 'string' && MODALITIES.includes(m)),
    ),
  ]
  return filtered.length > 0 ? filtered : undefined
}

/** 读取服务提供方公布的思考档位。 */
export function upstreamLevels(row) {
  const raw = Array.isArray(row?.supported_reasoning_levels)
    ? row.supported_reasoning_levels
    : Array.isArray(row?.reasoning_levels)
      ? row.reasoning_levels
      : undefined
  if (!raw) return undefined
  const extracted = raw
    .map((x) => (typeof x === 'string' ? x : x?.effort))
    .filter((v) => typeof v === 'string' && v.length > 0)
  return extracted.length > 0 ? extracted : undefined
}

/**
 * 将公布的档位筛选为 DSH 支持的七档，并记录默认传输值。
 * - 当 `noneMapsToOff` 为真时，将 `"none"` 映射为 DSH 档位 `"off"`，默认传输值为 `"none"`。
 * - 将 `"ultra"` 等不支持的档位记录到 `skipped`。
 */
export function toDesiredLevels(levels, noneMapsToOff = true) {
  const desired = []
  const wireDefaults = new Map()
  const skipped = []

  for (const level of levels) {
    if (LEVELS.includes(level)) {
      if (!desired.includes(level)) desired.push(level)
      if (!wireDefaults.has(level)) wireDefaults.set(level, level)
    } else if (level === 'none' && noneMapsToOff) {
      if (!desired.includes('off')) desired.push('off')
      if (!wireDefaults.has('off')) wireDefaults.set('off', 'none')
    } else {
      if (!skipped.includes(level)) skipped.push(level)
    }
  }

  desired.sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b))
  return { desired, wireDefaults, skipped }
}

/**
 * 构建下一版 `reasoningEfforts` 映射：
 * - 保留已有的自定义传输值。
 * - 使用 `wireDefaults.get(level)`（因此由 `"none"` 映射而来的 `off` 默认传输值为 `"none"`）。
 * - 至少需要一个 `off` 之外的档位，以满足 `llm-pi-ai` 校验要求。
 */
export function nextEfforts(existing, targetLevels, wireDefaults = new Map()) {
  const current =
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : {}
  const hasThinking = targetLevels.some((l) => l !== 'off')
  if (!hasThinking) return undefined

  const next = {}
  for (const level of targetLevels) {
    if (
      Object.prototype.hasOwnProperty.call(current, level) &&
      current[level] !== undefined
    ) {
      next[level] = current[level]
    } else {
      next[level] = wireDefaults.get(level) ?? level
    }
  }
  return next
}

/** 获取模型条目中现有的档位名称。 */
export function currentLevels(model) {
  const declared = model?.reasoningEfforts
  if (!declared || typeof declared !== 'object' || Array.isArray(declared))
    return []
  return Object.keys(declared)
}

/** 按标准顺序合并双方已知的档位，不移除现有档位。 */
export function unionLevels(existing, advertised) {
  return LEVELS.filter(
    (level) => existing.includes(level) || advertised.includes(level),
  )
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export async function fetchUpstreamModels(baseURL, apiKey, signal) {
  const url = String(baseURL).replace(/\/+$/, '') + '/models'
  const headers = { Accept: 'application/json' }
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey
  const resp = await fetch(url, { headers, signal })
  if (!resp.ok) throw new Error(`请求 ${url} 失败：HTTP ${resp.status}`)
  const data = await resp.json()
  if (Array.isArray(data?.data)) return data.data
  if (
    data?.models &&
    typeof data.models === 'object' &&
    !Array.isArray(data.models)
  ) {
    return Object.entries(data.models)
      .filter(
        ([, raw]) => raw && typeof raw === 'object' && !Array.isArray(raw),
      )
      .map(([key, raw]) => ({ id: raw.id ?? key, ...raw }))
  }
  return []
}

function readProvider(current, inherited, key) {
  const over = current?.providers?.[key]
  const under = inherited?.providers?.[key]
  const pick = (field) =>
    over?.[field] !== undefined ? over[field] : under?.[field]
  return {
    key,
    apiKeyEnv: pick('apiKeyEnv'),
    baseURL: pick('baseURL'),
    models: Array.isArray(pick('models')) ? pick('models') : [],
  }
}

function mergeModels(over, under) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(over) ? over : []) {
    if (typeof m?.id === 'string') seen.add(m.id)
    out.push(m)
  }
  for (const m of Array.isArray(under) ? under : []) {
    if (typeof m?.id !== 'string' || seen.has(m.id)) continue
    out.push(m)
  }
  return out
}

export function declaredProviderKeys(current, inherited) {
  const keys = []
  for (const layer of [current?.providers, inherited?.providers]) {
    if (!layer || typeof layer !== 'object') continue
    for (const key of Object.keys(layer))
      if (!keys.includes(key)) keys.push(key)
  }
  return keys
}

function withSyncedMetadata(current, inherited, changes) {
  const providers = { ...(current?.providers ?? {}) }
  for (const key of new Set(changes.map((c) => c.provider))) {
    const byModel = new Map(
      changes.filter((c) => c.provider === key).map((c) => [c.model, c]),
    )
    if (!byModel.size) continue
    const stored = current?.providers?.[key] ?? {}
    const source = mergeModels(
      current?.providers?.[key]?.models,
      inherited?.providers?.[key]?.models,
    )
    const priorById = new Map(
      (Array.isArray(stored.models) ? stored.models : [])
        .filter((m) => typeof m?.id === 'string')
        .map((m) => [m.id, m]),
    )
    const models = source.map((m) => {
      const change = byModel.get(m?.id)
      const prior = priorById.get(m?.id)
      const base = prior ?? m
      if (!change) return base
      const updated = { ...base }
      if (change.toInput !== undefined) updated.input = change.toInput
      if (change.toEfforts !== undefined)
        updated.reasoningEfforts = change.toEfforts
      return updated
    })
    providers[key] = { ...stored, models }
  }
  return providers
}

/**
 * 根据各服务提供方 `/v1/models` 接口公布的信息同步已声明的服务提供方。
 *
 * @param ctx - 提供配置编辑器与凭据服务的插件上下文。
 * @param args - 服务提供方及同步选项。
 */
export async function runSync(ctx, args = {}) {
  const {
    provider: wantProvider,
    dryRun = true,
    noneMapsToOff = true,
    only,
    replace = false,
    syncModalities = true,
    syncReasoning = true,
  } = args ?? {}

  const notes = []
  try {
    const rows = ctx.configEditor.configuration()
    const row = findEntry(rows)
    if (!row) {
      return {
        ok: false,
        error: '当前配置中未找到受支持的模型服务提供方条目',
        diagnostics: describeEntries(rows),
        notes,
      }
    }
    const allKeys = declaredProviderKeys(row.override, row.inherited)
    if (!allKeys.length) {
      return {
        ok: false,
        error: `配置条目“${String(row.entry?.id ?? '')}”中没有服务提供方设置`,
        diagnostics: describeEntries(rows),
        notes,
      }
    }
    const keys = wantProvider
      ? allKeys.includes(wantProvider)
        ? [wantProvider]
        : []
      : allKeys
    if (!keys.length) {
      return {
        ok: false,
        error: `Provider “${wantProvider}”未在配置条目“${String(row.entry?.id ?? '')}”中声明`,
        notes,
        diagnostics: describeEntries(rows),
      }
    }

    const changes = []
    const results = []
    let upstreamModels = 0
    let catalogModels = 0

    for (const key of keys) {
      const per = await planProvider({
        ctx,
        provider: readProvider(row.override, row.inherited, key),
        only,
        replace,
        noneMapsToOff,
        syncModalities,
        syncReasoning,
        notes,
      })
      upstreamModels += per.upstreamModels
      catalogModels += per.catalogModels
      results.push(per.summary)
      changes.push(...per.changes)
    }

    const skippedAny = [...new Set(changes.flatMap((c) => c.skipped ?? []))]
    if (skippedAny.length) {
      notes.push(
        `已跳过 DSH 不支持的 thinking level 级别 ${skippedAny.join('、')}：DSH 的 llm-pi-ai 仅支持 off、minimal、low、medium、high、xhigh、max 这 7 个级别。`,
      )
    }

    const report = {
      ok: true,
      provider: keys.join(','),
      dryRun,
      upstreamModels,
      catalogModels,
      changes,
      notes,
      applied: false,
      providers: results,
    }

    if (dryRun || !changes.length) return report

    const fresh =
      ctx.configEditor
        .configuration()
        .find(
          (r) => r?.entry?.id === row.entry?.id || r?.entry === row.entry,
        ) ?? row
    const current = fresh.override ?? row.override ?? {}
    const inherited = fresh.inherited ?? row.inherited ?? {}

    await ctx.configEditor.edit(row.entry, (editCurrent, editInherited) => {
      const usable =
        editCurrent &&
        typeof editCurrent === 'object' &&
        Object.keys(editCurrent).length > 0
      const base = usable ? editCurrent : current
      const lower =
        editInherited &&
        typeof editInherited === 'object' &&
        Object.keys(editInherited).length > 0
          ? editInherited
          : inherited
      return { ...base, providers: withSyncedMetadata(base, lower, changes) }
    })
    // 通知设置表单，以便立即向 Web UI 广播 `settings/document-updated`。
    try {
      ctx.settings?.describe?.()
    } catch {}
    report.applied = true
    return report
  } catch (error) {
    return {
      ok: false,
      provider: wantProvider,
      dryRun,
      changes: [],
      notes,
      diagnostics: [],
      error:
        String(error?.message ?? error) +
        (error?.stack ? `\n${String(error.stack).split('\n')[1] ?? ''}` : ''),
    }
  }
}

async function planProvider({
  ctx,
  provider,
  only,
  replace,
  noneMapsToOff,
  syncModalities,
  syncReasoning,
  notes,
}) {
  const { key, apiKeyEnv, baseURL, models } = provider
  const summary = {
    provider: key,
    ok: true,
    models: models.length,
    changed: 0,
    upstream: 0,
    error: undefined,
  }
  const empty = {
    changes: [],
    upstreamModels: 0,
    catalogModels: models.length,
    summary,
  }

  if (!models.length) {
    summary.error = '未声明模型'
    notes.push(`${key}：未声明模型，未作修改`)
    return empty
  }
  if (!baseURL) {
    summary.error = '未配置服务地址'
    notes.push(`${key}：未配置服务地址，未作修改`)
    return empty
  }

  let upstream
  try {
    let apiKey
    if (apiKeyEnv) {
      const cred = await ctx.credentials.resolve(apiKeyEnv)
      if (!cred?.value) {
        summary.error = `未配置凭据变量“${apiKeyEnv}”`
        notes.push(`${key}：未配置凭据变量“${apiKeyEnv}”，未作修改`)
        return empty
      }
      apiKey = cred.value
    }
    const signal = AbortSignal.timeout(20000)
    upstream = await fetchUpstreamModels(baseURL, apiKey, signal)
  } catch (error) {
    summary.error = String(error?.message ?? error)
    summary.ok = false
    notes.push(`${key}：无法读取 ${baseURL}/models：${summary.error}，未作修改`)
    return empty
  }

  const byId = new Map(upstream.map((m) => [m?.id, m]))
  summary.upstream = upstream.length

  const changes = []
  const wanted = new Set(
    models
      .map((m) => m?.id)
      .filter(
        (id) => typeof id === 'string' && (!only?.length || only.includes(id)),
      ),
  )

  for (const model of models) {
    const id = model?.id
    if (typeof id !== 'string' || !wanted.has(id)) continue
    const up = byId.get(id)
    if (!up) {
      notes.push(`${key} / ${id}：在 provider 上游未找到该模型，未作修改`)
      continue
    }

    let toInput
    const fromInput = Array.isArray(model?.input) ? model.input : undefined
    if (syncModalities) {
      const advertisedInput = upstreamInputModalities(up)
      if (advertisedInput && !sameJson(fromInput, advertisedInput)) {
        toInput = advertisedInput
      }
    }

    let toEfforts
    let skipped = []
    let advertised = []
    const fromLevels = currentLevels(model)
    if (syncReasoning && up.reasoning !== false) {
      const levels = upstreamLevels(up)
      if (levels) {
        const parsed = toDesiredLevels(levels, noneMapsToOff)
        advertised = parsed.desired
        skipped = parsed.skipped
        if (parsed.desired.length) {
          const targetLevels = replace
            ? parsed.desired
            : unionLevels(fromLevels, parsed.desired)
          const builtEfforts = nextEfforts(
            model?.reasoningEfforts,
            targetLevels,
            parsed.wireDefaults,
          )
          if (
            builtEfforts &&
            !sameJson(model?.reasoningEfforts, builtEfforts)
          ) {
            toEfforts = builtEfforts
          }
        }
      }
    }

    if (toInput === undefined && toEfforts === undefined) continue

    changes.push({
      provider: key,
      model: id,
      from: fromLevels,
      to: toEfforts ? Object.keys(toEfforts) : fromLevels,
      ...(fromInput ? { fromInput } : {}),
      ...(toInput ? { toInput } : {}),
      ...(toEfforts ? { toEfforts } : {}),
      advertised,
      skipped,
    })
  }

  summary.changed = changes.length
  return {
    changes,
    upstreamModels: upstream.length,
    catalogModels: models.length,
    summary,
  }
}
