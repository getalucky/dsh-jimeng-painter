/**
 * test/prompt.test.mjs —— 提示词编排的离线测试
 * 不碰 Edge、不碰 DSH，只验证顺序、去重、自动风格和预设完整性。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composePrompt,
  normalizeStyleId,
  resolveFrame,
  styleOptions,
  STYLES,
  STYLE_IDS,
} from '../lib/prompt.mjs'

test('按画质→镜头/景别/机位→构图→主体→光线→材质→避免项的顺序编排', () => {
  const r = composePrompt({ prompt: '蓝发鲸鱼少女在珊瑚礁间自拍' })
  assert.equal(r.style.id, 'deepsea')
  assert.equal(r.optimized, true)
  assert.ok(r.text.startsWith('深海电影感摄影'), r.text)
  const 位置 = [
    r.text.indexOf('深海电影感摄影'),
    r.text.indexOf('35mm 广角纪实镜头'),
    r.text.indexOf('蓝发鲸鱼少女'),
    r.text.indexOf('丁达尔光束'),
    r.text.indexOf('避免：'),
  ]
  assert.ok(位置.every((n) => n >= 0), '有环节没拼进去：' + r.text)
  assert.deepEqual([...位置].sort((a, b) => a - b), 位置, '顺序不对：' + r.text)
  assert.ok(r.text.trim().endsWith('。'))
  assert.ok(r.length > 0)
})

test('style=off 原样返回，不追加任何风格词', () => {
  const raw = '一只橘猫，坐在窗台上。'
  const r = composePrompt({ prompt: raw, style: 'off' })
  assert.equal(r.text, raw)
  assert.equal(r.optimized, false)
  assert.equal(r.style.id, 'off')
  assert.deepEqual(r.warnings, [])
  assert.ok(!r.text.includes('避免：'))
})

test('未知风格 / 未知镜头直接报错，不静默退回默认', () => {
  assert.throws(() => composePrompt({ prompt: '猫', style: '不存在的风格' }), /未知风格/)
  assert.throws(() => composePrompt({ prompt: '猫', style: 'cinematic', lens: '不存在的镜头' }), /未知镜头/)
})

test('auto 能按提示词挑风格，普通描述退回电影写实', () => {
  assert.equal(composePrompt({ prompt: '水墨山水，远山薄雾' }).style.id, 'ink')
  assert.equal(composePrompt({ prompt: '动漫少女站在天台' }).style.id, 'anime')
  assert.equal(composePrompt({ prompt: '产品静物，香水瓶' }).style.id, 'product')
  assert.equal(composePrompt({ prompt: '一个女孩的写真' }).style.id, 'portrait')
  assert.equal(composePrompt({ prompt: '复古胶片少女' }).style.id, 'film')
  assert.equal(composePrompt({ prompt: '一只橘猫' }).style.id, 'cinematic')
})

test('auto 遇到油画/像素/3D/黑白等明确媒介时不硬套风格', () => {
  for (const prompt of ['油画风格的橘猫', '像素风小镇', '3D 渲染的鲸鱼', '黑白单色人像']) {
    const r = composePrompt({ prompt })
    assert.equal(r.optimized, false, prompt)
    assert.equal(r.style.id, 'off', prompt)
    assert.ok(r.notes.some((n) => n.includes('明确媒介')), prompt)
  }
  // 显式指定风格时仍然按用户要求编排
  assert.equal(composePrompt({ prompt: '油画风格的橘猫', style: 'cinematic' }).style.id, 'cinematic')
})

test('提示词里已有镜头/景别/构图/光线时，不重复叠风格默认值', () => {
  const r = composePrompt({ prompt: '85mm 特写，三分法构图，动漫少女站在天台，逆光' })
  assert.equal(r.style.id, 'anime')
  assert.ok(r.text.includes('85mm'))
  assert.ok(!r.text.includes('35mm 广角纪实镜头'), '不该再叠默认 35mm：' + r.text)
  assert.ok(!r.text.includes('中景，主体约占画面一半'), '不该再叠默认景别：' + r.text)
  assert.ok(!r.text.includes('三分法构图，主体位于三分线交点'), '不该再叠默认构图：' + r.text)
  assert.ok(!r.text.includes('逆光轮廓光，发丝与边缘透亮'), '不该再叠默认光线：' + r.text)
  assert.ok(r.notes.some((n) => n.includes('跳过风格默认')))
})

test('显式参数覆盖风格默认值，构图最多两个', () => {
  const r = composePrompt({
    prompt: '一只猫',
    style: 'cinematic',
    lens: 'macro',
    composition: '对称构图,留白,对角线',
    lighting: '伦勃朗',
  })
  assert.ok(r.text.includes('100mm 微距镜头'))
  assert.ok(r.text.includes('对称构图'))
  assert.ok(r.text.includes('留白'))
  assert.ok(!r.text.includes('对角线构图'), '构图超过两个没截住：' + r.text)
  assert.ok(r.text.includes('伦勃朗布光'))
})

test('超长提示词给警告但不硬截断', () => {
  const long = '猫'.repeat(240)
  const r = composePrompt({ prompt: long, style: 'cinematic' })
  assert.equal(r.overLimit, true)
  assert.equal(r.warnings.length, 1)
  assert.ok(r.text.includes(long), '主体被截断了')
})

test('风格 id / 中文名 / 别名都能归一化', () => {
  assert.equal(normalizeStyleId('深海'), 'deepsea')
  assert.equal(normalizeStyleId('人像'), 'portrait')
  assert.equal(normalizeStyleId('none'), 'off')
  assert.equal(normalizeStyleId('AUTO'), 'auto')
  assert.equal(normalizeStyleId('不存在'), null)
  assert.equal(normalizeStyleId(''), null)
})

test('styleOptions 覆盖 auto / 全部风格 / off', () => {
  const opts = styleOptions()
  assert.equal(opts[0].id, 'auto')
  assert.equal(opts[opts.length - 1].id, 'off')
  for (const id of STYLE_IDS) assert.ok(opts.some((o) => o.id === id), id)
})

test('所有风格的镜头/构图/光线引用都能在 frames.json 里找到', () => {
  assert.ok(STYLES.length >= 8)
  for (const style of STYLES) {
    assert.ok(style.medium, style.id + ' 缺 medium')
    assert.ok(Array.isArray(style.avoid) && style.avoid.length > 0, style.id + ' 缺 avoid')
    for (const kind of ['lens', 'shot', 'angle', 'lighting']) {
      assert.ok(resolveFrame(kind, style[kind]), `${style.id}.${kind}=${style[kind]} 找不到`)
    }
    assert.ok(Array.isArray(style.composition) && style.composition.length >= 1 && style.composition.length <= 2)
    for (const c of style.composition) assert.ok(resolveFrame('composition', c), `${style.id}.composition=${c} 找不到`)
  }
})
