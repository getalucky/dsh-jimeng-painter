import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODELS, MODEL_NAMES, RATIOS, RESOLUTIONS, TOOL_RESOLUTIONS } from '../lib/models.js'
import { resolveConfig } from '../lib/index.js'

test('模型清单包含即梦网页当前可选模型', () => {
  for (const name of [
    'Seedream 5.5',
    'Seedream 5.0 Pro',
    '即梦 ImageMax 1.0',
    '图片美学模型 V8.2',
    'Seedream 5.0 Aurora',
    'Seedream 5.0 Flash',
    'Seedream 5.0 Lite',
    'Anycook 1.0',
    'Seedream 4.7',
    'Seedream 3.0',
  ]) {
    assert.equal(MODEL_NAMES.includes(name), true, name)
  }
  assert.equal(new Set(MODEL_NAMES).size, MODEL_NAMES.length, '模型名不能重复')
})

test('比例与清晰度选项符合页面', () => {
  assert.deepEqual(RATIOS, ['智能', '1:1', '3:4', '16:9', '4:3', '9:16', '2:3', '3:2', '21:9'])
  assert.deepEqual(RESOLUTIONS, ['1.5K', '2K', '4K', '自定义'])
  assert.deepEqual(TOOL_RESOLUTIONS, ['1.5K', '2K', '4K'])
})

test('配置默认值', () => {
  const c = resolveConfig(null)
  assert.equal(c.enabled, true)
  assert.equal(c.cdpPort, 9335)
  assert.equal(c.defaultModel, 'Seedream 5.5')
  assert.equal(c.timeoutMs, 300000)
  assert.equal(c.outSubdir, 'jimeng-images')
  assert.equal(c.defaultStyle, 'auto')
})

test('默认风格支持 id / 中文别名，非法值退回 auto', () => {
  assert.equal(resolveConfig({ defaultStyle: '深海' }).defaultStyle, 'deepsea')
  assert.equal(resolveConfig({ defaultStyle: '人像' }).defaultStyle, 'portrait')
  assert.equal(resolveConfig({ defaultStyle: 'off' }).defaultStyle, 'off')
  assert.equal(resolveConfig({ defaultStyle: '不存在' }).defaultStyle, 'auto')
})

test('显式关闭后 enabled=false', () => {
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
})

test('模型价格备注非空', () => {
  assert.ok(MODELS.length >= 10)
  for (const m of MODELS) assert.ok(m.note.length > 0, m.name)
})
