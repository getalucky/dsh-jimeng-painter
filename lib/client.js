// dsh-jimeng-painter · 网页半边
//
// 在 **DSH 设置** 左侧栏加一项「即梦生图」：默认模型 / 比例 / 清晰度 / 张数 / 风格。
// 模型清单可以直接从即梦页面实时读（点「刷新列表」），读不到就退回插件里的静态清单。
//
// ⚠ 这个文件必须长这样：window.__ModuleLoader__.load({id, factory})，
//   factory 里只能 require('react')，不能写 import / export。
//   写成普通 ESM 会让宿主 ClientModuleRegistry.flush 抛错，整个 DSH 界面起不来。

window.__ModuleLoader__.load({
  id: 'dsh-jimeng-painter',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const inject = ['slots']

    /** 后端接口前缀；同源相对路径，端口由宿主决定，不写死。 */
    const B = '/dsh-jimeng-painter/api'
    const SID = 'jimeng-painter'
    const 样式id = 'dsh-jimeng-painter-style'

    const get = (p) =>
      fetch(B + p, { cache: 'no-store', credentials: 'same-origin' })
        .then((r) => r.json())
        .catch(() => null)

    const post = (p, body) =>
      fetch(B + p, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
        .then((r) => r.json().catch(() => null))
        .catch(() => null)

    function 确保样式() {
      if (typeof document === 'undefined') return
      if (document.getElementById(样式id)) return
      const el = document.createElement('style')
      el.id = 样式id
      el.textContent = `
.jm-panel { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 28px; color: var(--dsw-alias-label-primary, inherit); }
.jm-hero { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.jm-heroTitle { font-size: 16px; font-weight: 600; }
.jm-heroSub { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.jm-badge { margin-left: auto; font-size: 11px; line-height: 20px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28)); color: var(--dsw-alias-label-secondary, inherit); }
.jm-badgeOk { border-color: rgba(23,122,75,.45); color: #17805a; }
.jm-badgeWarn { border-color: rgba(176,122,0,.45); color: #a8730b; }
.jm-body { display: flex; flex-direction: column; gap: 14px; padding: 16px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.2)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); }
.jm-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.jm-label { flex: none; width: 88px; font-size: 13px; color: var(--dsw-alias-label-secondary, inherit); }
.jm-control { display: flex; gap: 8px; align-items: center; flex: 1 1 260px; min-width: 220px; }
.jm-select { flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 8px; border-radius: 8px; font-size: 13px; color: inherit; background: var(--dsw-specific-input-bg, var(--dsw-alias-bg-layer-1, transparent)); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.jm-btn { height: 32px; padding: 0 12px; border-radius: 8px; font-size: 13px; color: inherit; cursor: pointer; background: var(--dsw-alias-bg-layer-1, transparent); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.jm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.6)); }
.jm-btn:disabled { opacity: .5; cursor: default; }
.jm-primary { background: #3b6ef6; border-color: #3b6ef6; color: #fff; }
.jm-hint { flex: 1 1 100%; padding-left: 100px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
.jm-err { color: #c0392b; }
.jm-alert { font-size: 12px; line-height: 18px; padding: 8px 10px; border-radius: 8px; }
.jm-alertErr { color: #c0392b; background: rgba(192,57,43,.08); }
.jm-alertWarn { color: #a8730b; background: rgba(176,122,0,.1); }
.jm-alertOk { color: #17805a; background: rgba(23,122,75,.08); }
.jm-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding-top: 12px; border-top: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.25)); }
.jm-check { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.jm-check input { width: 15px; height: 15px; accent-color: var(--dsw-alias-brand-primary, #4b7bec); cursor: pointer; }
.jm-saved { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.9)); }
`
      document.head?.appendChild?.(el)
    }

    const 从配置 = (c) => ({
      defaultModel: String((c && c.defaultModel) || ''),
      defaultRatio: String((c && c.defaultRatio) || '智能'),
      defaultResolution: String((c && c.defaultResolution) || '1.5K'),
      defaultCount: Number((c && c.defaultCount) || 1),
      defaultStyle: String((c && c.defaultStyle) || 'auto'),
      lockDefaults: Boolean(c && c.lockDefaults),
    })

    function 时间(iso) {
      const d = new Date(iso)
      if (!iso || Number.isNaN(d.getTime())) return ''
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    }

    function Section() {
      确保样式()

      const [载入中, 设载入中] = React.useState(true)
      const [选项, 设选项] = React.useState(null)
      const [表单, 设表单] = React.useState(null)
      const [基准, 设基准] = React.useState(null)
      const [实时, 设实时] = React.useState(null)
      const [刷新中, 设刷新中] = React.useState(false)
      const [保存中, 设保存中] = React.useState(false)
      const [提示, 设提示] = React.useState(null)
      const [补丁, 设补丁] = React.useState(null)
      const [加载错, 设加载错] = React.useState('')

      const 拉配置 = React.useCallback(() => {
        设载入中(true)
        return get('/config')
          .then((r) => {
            if (!r || !r.ok) {
              设加载错((r && r.error) || '读不到插件设置：设置接口可能没挂上（需要 DSH 重启后加载新版本插件）')
              return
            }
            设加载错('')
            设选项(r.options || null)
            设补丁(r.patch || null)
            const next = 从配置(r.config)
            设表单(next)
            设基准(next)
          })
          .finally(() => 设载入中(false))
      }, [])

      const 拉模型 = React.useCallback((强制, 打开浏览器) => {
        设刷新中(true)
        const q = (强制 ? '?refresh=1' : '') + (打开浏览器 ? (强制 ? '&' : '?') + 'launch=1' : '')
        return get('/models' + q)
          .then((r) => {
            if (!r) {
              设实时({ ok: false, names: [], models: [], error: '设置接口没有响应', at: '' })
              return
            }
            设实时({
              ok: !!r.ok,
              names: Array.isArray(r.names) ? r.names : [],
              models: Array.isArray(r.models) ? r.models : [],
              current: r.current || '',
              error: r.error || '',
              at: r.at || '',
              source: r.source || '',
              launched: !!r.launched,
              reason: r.reason || '',
            })
          })
          .finally(() => 设刷新中(false))
      }, [])

      React.useEffect(() => {
        拉配置()
        拉模型(false, false)
      }, [拉配置, 拉模型])

      const 实时名 = React.useMemo(() => new Set((实时 && 实时.names) || []), [实时])
      const 价格表 = React.useMemo(() => {
        const map = {}
        for (const m of (实时 && 实时.models) || []) {
          if (m && m.name && m.price) map[m.name] = String(m.price)
        }
        return map
      }, [实时])

      const 模型列表 = React.useMemo(() => {
        const names = []
        const 加 = (n) => {
          const s = String(n || '').trim()
          if (s && !names.includes(s)) names.push(s)
        }
        for (const n of (实时 && 实时.names) || []) 加(n)
        if (!names.length) {
          for (const m of (选项 && 选项.models) || []) 加(typeof m === 'string' ? m : m && m.name)
        }
        // 当前默认值不在列表里也要显示出来，否则 select 会自己跳到第一项。
        if (表单 && 表单.defaultModel) 加(表单.defaultModel)
        return names
      }, [实时, 选项, 表单])

      const 模型标签 = (name) => {
        const 价 = 价格表[name] ? ' · ' + 价格表[name] : ''
        const 不在 = 实时 && 实时.ok && !实时名.has(name)
        return name + 价 + (不在 ? '（页面上没有）' : '')
      }

      const 改 = (key, value) => 设表单((prev) => (prev ? { ...prev, [key]: value } : prev))
      const 脏 = Boolean(表单 && 基准 && JSON.stringify(表单) !== JSON.stringify(基准))

      const 保存 = React.useCallback(async () => {
        if (!表单) return
        设保存中(true)
        设提示(null)
        const r = await post('/config', {
          defaultModel: 表单.defaultModel,
          defaultRatio: 表单.defaultRatio,
          defaultResolution: 表单.defaultResolution,
          defaultCount: 表单.defaultCount,
          defaultStyle: 表单.defaultStyle,
          lockDefaults: 表单.lockDefaults === true,
        })
        设保存中(false)
        if (!r || !r.ok) {
          const errs = (r && r.errors && r.errors.length) ? r.errors.join('；') : ''
          设提示({ kind: 'err', text: errs || (r && r.error) || '保存失败（设置接口没有响应）' })
          return
        }
        const next = 从配置(r.config)
        设表单(next)
        设基准(next)
        if (r.patch) 设补丁(r.patch)
        const file = (r.patch && r.patch.file) || (补丁 && 补丁.file) || 'cordis.patch.yml'
        设提示(r.warning
          ? { kind: 'warn', text: r.warning }
          : { kind: 'ok', text: `已保存到 ${file}；下次 jimeng_paint 不传参就用这套默认值。` })
      }, [表单, 补丁])

      const 状态徽 = 刷新中
        ? '读取中…'
        : (实时 && 实时.ok)
          ? `实时模型 · ${(实时.names || []).length} 个`
          : '静态模型清单'

      const 当前比例 = (表单 && 表单.defaultRatio) || '智能'
      const 分辨率列表 = (选项 && 选项.resolutions) || ['1.5K', '2K', '4K']
      const 张数列表 = (选项 && 选项.counts) || [1, 2, 3, 4]
      const 风格列表 = (选项 && Array.isArray(选项.styles) && 选项.styles.length)
        ? 选项.styles
        : [{ id: 'auto', label: '自动识别' }, { id: 'off', label: '不优化（原样送即梦）' }]

      return h(
        'div',
        { className: 'jm-panel' },
        h(
          'div',
          { className: 'jm-hero' },
          h('span', { className: 'jm-heroTitle' }, '即梦生图'),
          h('span', { className: 'jm-heroSub' }, '默认参数；工具调用时不传就用这里的，单次传参仍可覆盖'),
          h('span', { className: 'jm-badge ' + (实时 && 实时.ok ? 'jm-badgeOk' : 'jm-badgeWarn') }, 状态徽),
        ),
        加载错 ? h('div', { className: 'jm-alert jm-alertErr' }, 加载错) : null,
        !表单
          ? h('div', { className: 'jm-hint' }, 载入中 ? '读取设置中…' : '没读到设置')
          : h(
              'div',
              { className: 'jm-body' },
              // 默认模型 + 刷新
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label', htmlFor: 'jm-model' }, '默认模型'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'select',
                    {
                      id: 'jm-model',
                      className: 'jm-select',
                      value: 表单.defaultModel,
                      onChange: (e) => 改('defaultModel', e.target.value),
                    },
                    ...模型列表.map((n) => h('option', { key: n, value: n }, 模型标签(n))),
                  ),
                  h(
                    'button',
                    { className: 'jm-btn', type: 'button', disabled: 刷新中, onClick: () => 拉模型(true, true) },
                    刷新中 ? '读取中…' : '刷新列表',
                  ),
                ),
                h(
                  'div',
                  { className: 'jm-hint' },
                  刷新中
                    ? '正在连即梦… 第一次会自动打开 Edge 窗口（约 10–30 秒），读的是页面上现在能选的模型。'
                    : 实时 && 实时.ok
                      ? `从即梦页面读到 ${实时.names.length} 个模型${实时.current ? `，页面当前用的是「${实时.current}」` : ''}${实时.at ? `（${时间(实时.at)}）` : ''}${实时.launched ? '；已顺手打开 Edge' : ''}`
                      : 实时 && 实时.reason === 'cdp-offline'
                        ? '还没连上即梦（那套带调试端口的 Edge 没开）。点「刷新列表」会自动打开，第一次等十几秒。'
                        : 实时 && 实时.error
                          ? h('span', { className: 'jm-err' }, `实时读取失败，已退回静态清单：${实时.error}`)
                          : '点「刷新列表」会自动打开即梦（用的是装好调试端口的那套 Edge），读页面上当下能选的模型。',
                ),
              ),
              // 比例
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label', htmlFor: 'jm-ratio' }, '默认比例'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'select',
                    {
                      id: 'jm-ratio',
                      className: 'jm-select',
                      value: 当前比例,
                      onChange: (e) => 改('defaultRatio', e.target.value),
                    },
                    ...((选项 && 选项.ratios) || ['智能']).map((n) => h('option', { key: n, value: n }, n)),
                  ),
                ),
              ),
              // 清晰度
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label', htmlFor: 'jm-resolution' }, '默认清晰度'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'select',
                    {
                      id: 'jm-resolution',
                      className: 'jm-select',
                      value: 表单.defaultResolution,
                      onChange: (e) => 改('defaultResolution', e.target.value),
                    },
                    ...分辨率列表.map((n) => h('option', { key: n, value: n }, n)),
                  ),
                ),
                h('div', { className: 'jm-hint' }, '2K / 4K 每张消耗的积分更多。'),
              ),
              // 张数
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label', htmlFor: 'jm-count' }, '默认张数'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'select',
                    {
                      id: 'jm-count',
                      className: 'jm-select',
                      value: String(表单.defaultCount),
                      onChange: (e) => 改('defaultCount', Number(e.target.value)),
                    },
                    ...张数列表.map((n) => h('option', { key: String(n), value: String(n) }, `${n} 张`)),
                  ),
                ),
              ),
              // 默认风格
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label', htmlFor: 'jm-style' }, '默认风格'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'select',
                    {
                      id: 'jm-style',
                      className: 'jm-select',
                      value: 表单.defaultStyle || 'auto',
                      onChange: (e) => 改('defaultStyle', e.target.value),
                    },
                    ...风格列表.map((s) => h('option', { key: s.id, value: s.id }, s.label)),
                  ),
                ),
                h('div', { className: 'jm-hint' }, 'auto 按提示词自动选；off 原样送即梦。单次调用可传 style 覆盖。'),
              ),
              // 锁定默认值
              h(
                'div',
                { className: 'jm-row' },
                h('label', { className: 'jm-label' }, '锁定默认值'),
                h(
                  'div',
                  { className: 'jm-control' },
                  h(
                    'label',
                    { className: 'jm-check' },
                    h('input', {
                      type: 'checkbox',
                      checked: 表单.lockDefaults === true,
                      onChange: (e) => 改('lockDefaults', e.target.checked),
                    }),
                    h('span', null, 表单.lockDefaults ? '已锁：工具传参也盖不掉' : '未锁：单次调用可覆盖'),
                  ),
                ),
                h(
                  'div',
                  { className: 'jm-hint' },
                  '打开后，模型 / 比例 / 清晰度 / 张数 / 风格（含镜头、景别这些改写）一律只认这一页，agent 传什么都不作数。',
                ),
              ),
              提示
                ? h(
                    'div',
                    {
                      className:
                        'jm-alert ' +
                        (提示.kind === 'ok' ? 'jm-alertOk' : 提示.kind === 'warn' ? 'jm-alertWarn' : 'jm-alertErr'),
                    },
                    提示.text,
                  )
                : null,
              h(
                'div',
                { className: 'jm-actions' },
                h(
                  'button',
                  { className: 'jm-btn jm-primary', type: 'button', disabled: 保存中 || !脏, onClick: 保存 },
                  保存中 ? '保存中…' : '保存',
                ),
                h(
                  'button',
                  { className: 'jm-btn', type: 'button', disabled: 载入中, onClick: 拉配置 },
                  载入中 ? '读取中…' : '重新读取',
                ),
                h(
                  'span',
                  { className: 'jm-saved' },
                  补丁 && 补丁.last && 补丁.last.at
                    ? `上次保存：${时间(补丁.last.at)}${补丁.last.persisted === false ? '（未落盘）' : ''}`
                    : `改动会写进 ${(补丁 && 补丁.file) || 'cordis.patch.yml'}`,
                ),
              ),
            ),
      )
    }

    function apply(ctx) {
      const slots = (ctx && ctx.slots) || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots || typeof slots.inject !== 'function') return
      const 挂 = () =>
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: SID, order: 57, label: () => '即梦生图' },
            Section,
          ),
        )
      if (typeof ctx.effect === 'function') ctx.effect(挂, 'dsh-jimeng-painter: settings section')
      else 挂()
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
