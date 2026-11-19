/**
 * test/client.test.mjs —— 网页半边的离线冒烟
 *
 * 用假的 window.__ModuleLoader__ + 假 React 把 lib/client.js 跑一遍：
 * 能不能被 factory 物化、apply 会不会注册设置页、组件能不能生成元素树。
 * 真浏览器行为测不了，但「一加载就抛错把整个 DSH 界面带崩」这类问题能提前抓出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { MODEL_NAMES, RATIOS, TOOL_RESOLUTIONS } from '../lib/models.js'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(pkgRoot, 'lib', 'client.js'), 'utf8')

// 假 React：只要形状对，不真渲染
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(9) }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
}

const registrations = []
const 请求记录 = []
const sandbox = {
  window: { __ModuleLoader__: { load: (r) => registrations.push(r) } },
  console,
  fetch: (url, init) => {
    请求记录.push({ url: String(url), method: (init && init.method) || 'GET' })
    return Promise.resolve({ json: () => Promise.resolve(null) })
  },
  URL,
  Set,
  Map,
  Promise,
  JSON,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  RegExp,
  Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(src, sandbox, { filename: 'client.js' })

const requireStub = (spec) => {
  if (spec === 'react') return React
  throw new Error('客户端入口 require 了未知模块：' + spec)
}

test('脚本能执行并注册一次模块，id 正确', () => {
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, 'dsh-jimeng-painter')
  assert.equal(typeof registrations[0].factory, 'function')
})

const mod = registrations[0].factory(requireStub)

test('factory 物化出 apply / inject', () => {
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(Array.from(mod.inject), ['slots'])
})

test('apply 注册到 settings.section，元数据与组件正确', () => {
  const calls = []
  let Comp = null
  let meta = null
  const ctx = {
    get: (n) =>
      n === 'slots'
        ? {
            inject: (slot, fn) => {
              calls.push(slot)
              fn()
            },
            register: (m, C) => {
              meta = m
              Comp = C
              calls.push(m.id)
              return () => {}
            },
          }
        : undefined,
  }
  mod.apply(ctx)
  assert.ok(calls.includes('settings.section'), '没往 settings.section 注册')
  assert.equal(meta.name, 'settings.section')
  assert.equal(meta.id, 'jimeng-painter')
  assert.equal(meta.order, 57)
  assert.equal(typeof meta.label, 'function')
  assert.equal(meta.label(), '即梦生图')
  assert.equal(typeof Comp, 'function')

  const tree = Comp()
  assert.equal(tree.type, 'div')
  assert.ok(tree.props.className.includes('jm-panel'))
})

test('有 ctx.effect 时走 effect 包一层', () => {
  let effected = 0
  let registered = 0
  const ctx = {
    effect: (fn) => {
      effected += 1
      fn()
    },
    slots: {
      inject: (_slot, fn) => fn(),
      register: () => {
        registered += 1
        return () => {}
      },
    },
  }
  mod.apply(ctx)
  assert.equal(effected, 1)
  assert.equal(registered, 1)
})

test('没有 slots 服务时安静退出，不抛错', () => {
  assert.doesNotThrow(() => mod.apply({ get: () => undefined }))
  assert.doesNotThrow(() => mod.apply({}))
})

test('渲染出五个设置项（模型 / 比例 / 清晰度 / 张数 / 风格）的标签文案', () => {
  let Comp = null
  mod.apply({
    get: () => ({ inject: (_s, fn) => fn(), register: (_m, C) => { Comp = C; return () => {} } }),
  })
  const tree = Comp()
  const 文本 = []
  const 收集 = (node) => {
    if (node == null || typeof node === 'boolean') return
    if (typeof node === 'string' || typeof node === 'number') { 文本.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(收集); return }
    if (typeof node === 'function') { 收集(node({})); return }
    if (typeof node.type === 'function') { 收集(node.type(node.props)); return }
    收集(node.children)
    if (node.props && node.props.children) 收集(node.props.children)
  }
  收集(tree)
  const 全 = 文本.join('|')
  // 首次渲染表单还没回来，至少标题/徽章要在；具体字段用组件树里的 form 分支覆盖不到，就看静态文案。
  assert.ok(全.includes('即梦生图'), '没有标题')
  assert.ok(全.includes('静态模型清单'), '没有模型来源徽章')
})

// —— 下面几条把 useState 换成「按顺序喂值」，直接渲染有数据的表单分支 ——
// 钩子顺序（lib/client.js Section）：载入中 / 选项 / 表单 / 基准 / 实时 / 刷新中 / 保存中 / 提示 / 补丁 / 加载错
const 取组件 = () => {
  let Comp = null
  mod.apply({
    get: () => ({ inject: (_s, fn) => fn(), register: (_m, C) => { Comp = C; return () => {} } }),
  })
  return Comp
}

const 抽文本 = (node, out = []) => {
  if (node == null || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((n) => 抽文本(n, out)); return out }
  if (typeof node === 'function') { 抽文本(node({}), out); return out }
  if (typeof node.type === 'function') { 抽文本(node.type(node.props), out); return out }
  抽文本(node.children, out)
  if (node.props && node.props.children) 抽文本(node.props.children, out)
  return out
}

const 渲染树 = (states) => {
  const queue = states.slice()
  const 原版 = React.useState
  React.useState = (init) => {
    const v = queue.length ? queue.shift() : typeof init === 'function' ? init() : init
    return [v, () => {}]
  }
  try {
    return 取组件()()
  } finally {
    React.useState = 原版
  }
}

const 渲染 = (states) => 抽文本(渲染树(states)).join('|')

const 找节点 = (node, 判据) => {
  if (node == null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = 找节点(n, 判据)
      if (hit) return hit
    }
    return null
  }
  if (判据(node)) return node
  const kids = [].concat(node.children || [], (node.props && node.props.children) || [])
  for (const n of kids) {
    const hit = 找节点(n, 判据)
    if (hit) return hit
  }
  return null
}

const 基准 = { defaultModel: 'Seedream 5.5', defaultRatio: '智能', defaultResolution: '1.5K', defaultCount: 2, defaultStyle: 'auto' }
const 选项 = {
  models: MODEL_NAMES,
  ratios: RATIOS,
  resolutions: TOOL_RESOLUTIONS,
  counts: [1, 2, 3, 4],
  styles: [
    { id: 'auto', label: '自动识别' },
    { id: 'cinematic', label: '电影写实' },
    { id: 'off', label: '不优化（原样送即梦）' },
  ],
}

test('有配置时渲染出五个下拉、刷新按钮和保存按钮', () => {
  const 全 = 渲染([
    false,
    选项,
    { ...基准 },
    { ...基准 },
    {
      ok: true,
      names: ['Seedream 5.5', 'Seedream 4.6'],
      models: [{ name: 'Seedream 5.5', price: '60积分/张' }, { name: 'Seedream 4.6' }],
      current: 'Seedream 5.5',
      at: '2026-11-15T04:30:00.000Z',
      error: '',
    },
    false,
    false,
    null,
    { file: 'cordis.patch.yml', last: { at: '2026-11-15T04:31:00.000Z', persisted: true } },
    '',
  ])
  for (const 词 of ['默认模型', '默认比例', '默认清晰度', '默认张数', '默认风格', '刷新列表', '保存', '2 张', '电影写实']) {
    assert.ok(全.includes(词), '缺文案：' + 词)
  }
  assert.ok(全.includes('实时模型 · 2 个'), '徽章没显示实时数量：' + 全.slice(0, 200))
  assert.ok(全.includes('60积分/张'), '价格没显示')
  assert.ok(全.includes('页面当前用的是「Seedream 5.5」'), '没显示页面当前模型')
  assert.ok(全.includes('上次保存：'), '没显示上次保存时间')
})

test('实时读取失败时退回静态清单并显示错误，不崩', () => {
  const 全 = 渲染([
    false,
    选项,
    { ...基准 },
    { ...基准 },
    {
      ok: false,
      live: false,
      source: 'static',
      names: MODEL_NAMES,
      models: MODEL_NAMES.map((name) => ({ name })),
      current: '',
      error: 'Edge 调试端口 9335 没开；先打开即梦页面',
      at: '',
    },
    false,
    false,
    null,
    { file: 'cordis.patch.yml', last: null },
    '',
  ])
  assert.ok(全.includes('静态模型清单'), '没退回静态徽章')
  assert.ok(全.includes('实时读取失败，已退回静态清单'), '没给错误提示')
  assert.ok(全.includes('Edge 调试端口 9335 没开'), '错误原文丢了')
  assert.ok(全.includes('默认模型'), '表单没渲染')
})

test('默认模型不在实时列表里时，选项上标出来', () => {
  const 全 = 渲染([
    false,
    选项,
    { ...基准, defaultModel: 'Anycook 1.0' },
    { ...基准, defaultModel: 'Anycook 1.0' },
    { ok: true, names: ['Seedream 5.5'], models: [{ name: 'Seedream 5.5' }], current: 'Seedream 5.5', at: '2026-11-15T04:30:00.000Z', error: '' },
    false,
    false,
    null,
    { file: 'cordis.patch.yml', last: null },
    '',
  ])
  assert.ok(全.includes('Anycook 1.0（页面上没有）'), '没有标注页面缺失：' + 全.slice(0, 300))
})

test('读取中徽章与保存警告也能渲染', () => {
  const 全 = 渲染([
    false,
    选项,
    { ...基准 },
    { ...基准 },
    { ok: true, names: ['Seedream 5.5'], models: [], current: '', at: '', error: '' },
    true,
    false,
    { kind: 'warn', text: '本次已经按新设置生效，但没能写进 cordis.patch.yml' },
    { file: 'cordis.patch.yml', last: { at: '2026-11-15T04:31:00.000Z', persisted: false } },
    '',
  ])
  assert.ok(全.includes('读取中…'), '徽章没显示读取中')
  assert.ok(全.includes('没能写进'), '警告没渲染')
  assert.ok(全.includes('（未落盘）'), '未落盘没标注')
})

test('点「刷新列表」会带 refresh=1 和 launch=1，让后端自己打开 Edge', async () => {
  请求记录.length = 0
  const tree = 渲染树([
    false,
    选项,
    { ...基准 },
    { ...基准 },
    { ok: false, names: MODEL_NAMES, models: MODEL_NAMES.map((name) => ({ name })), error: 'Edge 调试端口 9335 没开', at: '' },
    false,
    false,
    null,
    { file: 'cordis.patch.yml', last: null },
    '',
  ])
  const 按钮 = 找节点(tree, (n) => n.type === 'button' && 抽文本(n).includes('刷新列表'))
  assert.ok(按钮, '没找到刷新按钮')
  按钮.props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  const 命中 = 请求记录.find((r) => r.url.includes('/dsh-jimeng-painter/api/models'))
  assert.ok(命中, '没有请求模型接口：' + JSON.stringify(请求记录))
  assert.ok(命中.url.includes('refresh=1'), '没带 refresh=1：' + 命中.url)
  assert.ok(命中.url.includes('launch=1'), '没带 launch=1：' + 命中.url)
})
