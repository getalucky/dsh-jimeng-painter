/**
 * test/apply.test.mjs —— 插件入口的离线冒烟
 *
 * 假 ctx 走一遍 apply：两个工具还在不在、webServer 接口有没有挂上、
 * 参数表里的设置项描述对不对。不连浏览器、不生图。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, name, resolveConfig } from '../lib/index.js'
import { API_PREFIX } from '../lib/webapi.js'
import { COUNT_MAX, COUNT_MIN } from '../lib/settings.mjs'
import { RATIOS, TOOL_RESOLUTIONS } from '../lib/models.js'

function fakeCtx() {
  const tools = new Map()
  const routes = new Map()
  const listeners = []
  const ws = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    workingDirectory: { ensure: async () => process.cwd() },
    on: (event, fn) => listeners.push([event, fn]),
    inject: (deps, fn) => {
      if (deps.includes('webServer')) fn({ webServer: ws })
    },
  }
  return { ctx, tools, routes, listeners }
}

test('插件名和 inject 没被改坏', () => {
  assert.equal(name, 'dsh-jimeng-painter')
})

test('apply 注册两个工具，并挂上设置页接口', () => {
  const { ctx, tools, routes } = fakeCtx()
  apply(ctx, { enabled: true })
  assert.deepEqual([...tools.keys()].sort(), ['jimeng_paint', 'jimeng_status'])
  assert.deepEqual([...routes.keys()].sort(), [`${API_PREFIX}/config`, `${API_PREFIX}/models`].sort())
})

test('jimeng_paint 的参数表：模型/比例/清晰度/张数都可单次覆盖', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { enabled: true })
  const paint = tools.get('jimeng_paint')
  const props = paint.parameters.properties
  assert.deepEqual(paint.parameters.required, ['prompt'])
  assert.equal(paint.parameters.additionalProperties, false)
  assert.deepEqual(props.ratio.enum, RATIOS)
  assert.deepEqual(props.resolution.enum, TOOL_RESOLUTIONS)
  assert.equal(props.count.minimum, COUNT_MIN)
  assert.equal(props.count.maximum, COUNT_MAX)
  assert.match(props.model.description, /设置页|默认/)
  assert.match(props.count.description, /张/)
  assert.ok(Array.isArray(paint.output.schema.required) && paint.output.schema.required.includes('files'))
})

test('jimeng_status 的输出 schema 带上 modelsLive / modelsError', () => {
  const { ctx, tools } = fakeCtx()
  apply(ctx, { enabled: true })
  const st = tools.get('jimeng_status')
  const props = st.output.schema.properties
  assert.equal(props.modelsLive.type, 'boolean')
  assert.equal(props.modelsError.type, 'string')
  assert.equal(props.models.type, 'array')
  assert.equal(st.output.schema.additionalProperties, false)
  assert.equal(typeof st.output.render, 'function')
})

test('enabled:false 时什么都不注册', () => {
  const { ctx, tools, routes } = fakeCtx()
  apply(ctx, { enabled: false })
  assert.equal(tools.size, 0)
  assert.equal(routes.size, 0)
})

test('没有 webServer 也不影响工具注册', () => {
  const tools = new Map()
  apply({ tools: { register: (t) => tools.set(t.name, t) } }, { enabled: true })
  assert.deepEqual([...tools.keys()].sort(), ['jimeng_paint', 'jimeng_status'])
})

test('resolveConfig 的 defaultCount 只收 1-4 的整数，超范围退回默认值', () => {
  assert.equal(resolveConfig({}).defaultCount, 1)
  assert.equal(resolveConfig({ defaultCount: 3 }).defaultCount, 3)
  assert.equal(resolveConfig({ defaultCount: 9 }).defaultCount, 1)
  assert.equal(resolveConfig({ defaultCount: 0 }).defaultCount, 1)
  assert.equal(resolveConfig({ defaultCount: '2.7' }).defaultCount, 3)
})
