/**
 * dsh-magpie-sync 客户端代码。
 *
 * 在「设置 -> 模型」配置页底部提供服务提供方选择器与一键同步按钮。
 */

window.__ModuleLoader__.load({
  id: '@ovv/dsh-magpie-sync',
  factory: (require) => {
    const React = require('react')
    const h = (type, props, ...kids) =>
      React.createElement(type, props, ...kids)

    const PKG_NAME = '@ovv/dsh-magpie-sync'
    const ENTRY_ID = 'dsh-magpie-sync'
    const PI_AI_NS = 'llm-pi-ai'
    const BRIDGE_PATH = '/api/dsh-magpie-sync/run'

    const CSS = `
.dms-sync-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:var(--dsw-radius-lg,10px);
  background:var(--dsw-alias-settings-card-fill,rgba(127,127,127,.06));border:.5px solid var(--dsw-alias-settings-card-stroke,rgba(127,127,127,.22))}
.dms-sync-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dms-sync-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary,inherit)}
.dms-sync-controls{display:inline-flex;align-items:center;gap:8px;margin-left:auto;flex-wrap:wrap}
.dms-sync-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.dms-sync-select{box-sizing:border-box;height:30px;padding:0 8px;border-radius:var(--dsw-radius-sm,6px);
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:var(--dsw-alias-bg-layer-1,transparent);
  color:var(--dsw-alias-label-primary,inherit);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dms-sync-select:disabled{opacity:.45;cursor:default}
.dms-sync-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,inherit);margin:0}
.dms-sync-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:var(--dsw-radius-sm,6px);
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));background:0 0;color:var(--dsw-alias-label-primary,inherit);
  font:inherit;font-size:12px;font-weight:500;line-height:18px;cursor:pointer}
.dms-sync-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dms-sync-btn:disabled{opacity:.45;cursor:default}
.dms-sync-result{margin:2px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.05));
  font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;
  font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-secondary,inherit)}
.dms-sync-error{color:var(--dsw-alias-state-error-primary,#e5534b)}
`

    const TEXTS = {
      summary:
        '选择指定 provider，从其 /models 端点同步现有模型的输入模态及思考档位信息',
      title: 'Magpie 模型能力同步',
      providerLabel: '目标 provider：',
      allProviders: '全部已配置 provider',
      hint: '针对所选 provider，拉取 /models 端点以在 DSH 补充输入模态及思考档位信息。请注意，由于 DSH 使用的 llm-pi-ai 的限制，ultra 档位不受支持。',
      idle: '立即同步',
      busy: '同步中…',
      done: '重新同步',
    }

    /** 从共享设置镜像中提取候选服务提供方。 */
    function readProviderChoices(mirror) {
      const nsView =
        mirror.namespace?.(PI_AI_NS) ??
        mirror.getSnapshot?.()?.view?.namespaces?.find((n) => n.ns === PI_AI_NS)
      const providersObj = nsView?.value?.providers
      if (!providersObj || typeof providersObj !== 'object') return []
      const choices = []
      for (const [key, prof] of Object.entries(providersObj)) {
        if (!prof || typeof prof !== 'object') continue
        const hasBaseUrl =
          typeof prof.baseURL === 'string' && prof.baseURL.length > 0
        const modelCount = Array.isArray(prof.models) ? prof.models.length : 0
        const display =
          typeof prof.displayName === 'string' && prof.displayName
            ? `${prof.displayName}（${key}）`
            : key
        choices.push({
          key,
          label: `${display} — ${modelCount} 个模型${hasBaseUrl ? '' : '（未配置地址）'}`,
          hasBaseUrl,
        })
      }
      return choices
    }

    function createSyncComponent(form, mirror) {
      return function MagpieSyncCard(props) {
        if (props?.view === 'summary') return TEXTS.summary

        const [snap, setSnap] = React.useState(() => form.getSnapshot())
        const [choices, setChoices] = React.useState(() =>
          readProviderChoices(mirror),
        )
        const [selectedProvider, setSelectedProvider] = React.useState(
          () => snap.value?.targetProvider || 'magpie',
        )
        const [localBusy, setLocalBusy] = React.useState(false)
        const [localResult, setLocalResult] = React.useState('')
        const [localError, setLocalError] = React.useState(false)

        React.useEffect(() => {
          setSnap(form.getSnapshot())
          return form.subscribe(() => {
            const next = form.getSnapshot()
            setSnap(next)
            if (
              typeof next.value?.targetProvider === 'string' &&
              next.value.targetProvider
            ) {
              setSelectedProvider(next.value.targetProvider)
            }
            if (next.value?.lastResult) {
              setLocalResult(next.value.lastResult)
              setLocalError(next.value?.lastStatus === 'error')
            }
            if (next.value?.lastStatus && next.value?.lastStatus !== 'busy') {
              setLocalBusy(false)
            }
          })
        }, [])

        React.useEffect(() => {
          setChoices(readProviderChoices(mirror))
          return mirror.subscribe(() => {
            setChoices(readProviderChoices(mirror))
          })
        }, [])

        const status = localBusy ? 'busy' : (snap.value?.lastStatus ?? 'idle')
        const result = localResult || snap.value?.lastResult || ''
        const isError = localError || status === 'error'
        const disabled = status === 'busy'

        const onProviderChange = (e) => {
          const val = e.target.value
          setSelectedProvider(val)
          if (snap.status === 'ready') {
            void form.set('targetProvider', val)
          }
        }

        const onTrigger = async () => {
          const providerTarget = selectedProvider || 'magpie'
          setLocalBusy(true)
          setLocalError(false)
          setLocalResult(
            `正在请求同步服务提供方“${providerTarget}”的模型元数据…`,
          )
          try {
            // 优先通过本机回环接口立即执行
            const res = await fetch(BRIDGE_PATH, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json',
              },
              body: JSON.stringify({ provider: providerTarget }),
            })
            if (
              res.ok ||
              res.status === 400 ||
              res.status === 409 ||
              res.status === 500
            ) {
              const data = await res.json()
              setLocalBusy(false)
              setLocalError(!data.ok)
              setLocalResult(
                data.summary || (data.ok ? '同步完成。' : '同步失败。'),
              )
              void mirror.load?.()
              return
            }

            // 备用方式：通过易失设置变更触发同步
            if (snap.status !== 'ready') {
              await mirror.load()
            }
            const ok = await form.mutate([
              { op: 'set', path: ['targetProvider'], value: providerTarget },
              { op: 'set', path: ['syncTrigger'], value: Date.now() },
            ])
            if (!ok) {
              setLocalBusy(false)
              setLocalError(true)
              setLocalResult(
                '同步请求未能执行，请刷新页面或重启一次 dsh web 后重试。',
              )
            }
          } catch (err) {
            setLocalBusy(false)
            setLocalError(true)
            setLocalResult(`错误：${String(err?.message ?? err)}`)
          }
        }

        const btnLabel =
          status === 'busy'
            ? TEXTS.busy
            : status === 'done' || result
              ? TEXTS.done
              : TEXTS.idle
        const hasSelectedInChoices = choices.some(
          (c) => c.key === selectedProvider,
        )

        return h(
          'div',
          { className: 'dms-sync-card' },
          h(
            'div',
            { className: 'dms-sync-head' },
            h('span', { className: 'dms-sync-title' }, TEXTS.title),
            h(
              'div',
              { className: 'dms-sync-controls' },
              h('label', { className: 'dms-sync-label' }, TEXTS.providerLabel),
              h(
                'select',
                {
                  className: 'dms-sync-select',
                  value: selectedProvider,
                  disabled,
                  onChange: onProviderChange,
                },
                !hasSelectedInChoices && selectedProvider !== '*'
                  ? h(
                      'option',
                      { value: selectedProvider, key: selectedProvider },
                      selectedProvider,
                    )
                  : null,
                ...choices.map((c) =>
                  h('option', { value: c.key, key: c.key }, c.label),
                ),
                h('option', { value: '*', key: '*' }, TEXTS.allProviders),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dms-sync-btn',
                  disabled,
                  onClick: onTrigger,
                },
                btnLabel,
              ),
            ),
          ),
          h('p', { className: 'dms-sync-hint' }, TEXTS.hint),
          result
            ? h(
                'pre',
                {
                  className: isError
                    ? 'dms-sync-result dms-sync-error'
                    : 'dms-sync-result',
                },
                result,
              )
            : null,
        )
      }
    }

    function injectStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const id = 'dsh-magpie-sync-styles'
      const existing = document.getElementById(id)
      if (existing) {
        existing.textContent = CSS
        return () => {}
      }
      const tag = document.createElement('style')
      tag.id = id
      tag.dataset.plugin = PKG_NAME
      tag.dataset.pluginCss = PKG_NAME
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    function apply(ctx) {
      ctx.effect(() => injectStyles(), 'dsh-magpie-sync：样式')

      const form = ctx.configForms.get(ENTRY_ID)
      const mirror = ctx.configForms.describe()
      const SyncCard = createSyncComponent(form, mirror)

      // 将唯一同步卡片注入「设置 -> 模型」配置页底部。
      ctx.effect(
        () =>
          ctx.slots.inject('settings.models.footer', () =>
            ctx.slots.register(
              {
                name: 'settings.models.footer',
                id: 'dsh-magpie-sync',
                order: 50,
              },
              SyncCard,
            ),
          ),
        'dsh-magpie-sync：模型设置页脚插槽',
      )
    }

    var module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = ['slots', 'configForms']
    return module.exports
  },
})
