/**
 * test/settings.test.mjs —— 设置页写回 patch 的离线测试
 *
 * 全部在临时目录里做，绝不碰真插件目录里的 cordis.patch.yml。
 *   node --test tests/settings.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  PATCHABLE,
  COUNT_MIN,
  COUNT_MAX,
  yamlScalar,
  replaceLineValue,
  validatePatch,
  writePatchConfig,
  createSettings,
} from '../lib/settings.mjs'
import { resolveConfig } from '../lib/index.js'
import { RATIOS, TOOL_RESOLUTIONS } from '../lib/models.js'

const FIXTURE = [
  '# 测试用 patch',
  '- insert:',
  '    - id: dsh-jimeng-painter',
  '      name: dsh-jimeng-painter',
  '      config:',
  '        enabled: true',
  '        cdpPort: 9335',
  "        defaultModel: 'Seedream 5.5'  # 便宜点换 Flash",
  "        defaultRatio: '智能'",
  "        defaultResolution: '1.5K'",
  '        defaultCount: 1',
  "        defaultStyle: 'auto'",
  '',
].join('\n')

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jm-settings-'))
}

test('yamlScalar 用单引号并把内部的引号翻倍', () => {
  assert.equal(yamlScalar('Seedream 5.5'), "'Seedream 5.5'")
  assert.equal(yamlScalar("O'Brien"), "'O''Brien'")
  assert.equal(yamlScalar(3), "'3'")
})

test('replaceLineValue 只换值，缩进和行尾注释都留着', () => {
  const line = "        defaultModel: 'Seedream 5.5'  # 便宜点换 Flash"
  assert.equal(
    replaceLineValue(line, 'defaultModel', 'Seedream 5.0 Flash'),
    "        defaultModel: 'Seedream 5.0 Flash'  # 便宜点换 Flash",
  )
  // 没有注释的行
  assert.equal(replaceLineValue("  defaultCount: '1'", 'defaultCount', 4), "  defaultCount: 4")
  assert.equal(replaceLineValue('不是键值行', 'defaultCount', '4'), null)
})

test('validatePatch 收下合法的四项', () => {
  const out = validatePatch({
    defaultModel: 'Seedream 5.0 Flash',
    defaultRatio: '16:9',
    defaultResolution: '2K',
    defaultCount: 4,
  })
  assert.equal(out.ok, true)
  assert.deepEqual(out.errors, [])
  assert.deepEqual(out.values, {
    defaultModel: 'Seedream 5.0 Flash',
    defaultRatio: '16:9',
    defaultResolution: '2K',
    defaultCount: 4,
  })
})

test('validatePatch 挡住非法比例 / 清晰度 / 张数', () => {
  const bad = validatePatch({ defaultRatio: '5:4', defaultResolution: '8K', defaultCount: 9 })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.length, 3)

  for (const n of [0, 5, 1.5, -1, COUNT_MIN - 1, COUNT_MAX + 1]) {
    assert.equal(validatePatch({ defaultCount: n }).ok, false, '张数 ' + n + ' 不该通过')
  }
  assert.equal(validatePatch({ defaultCount: COUNT_MIN }).ok, true)
  assert.equal(validatePatch({ defaultCount: COUNT_MAX }).ok, true)
})

test('validatePatch 抹掉控制字符、忽略未知字段、拒绝空请求', () => {
  const out = validatePatch({ defaultModel: 'Seedream\n5.5\u0000', evil: 'x' })
  assert.equal(out.ok, true)
  assert.equal(out.values.defaultModel, 'Seedream 5.5')
  assert.deepEqual(out.ignored, ['evil'])

  assert.equal(validatePatch({}).ok, false)
  assert.equal(validatePatch(null).ok, false)
  assert.equal(validatePatch({ defaultModel: '   ' }).ok, false)
  assert.equal(validatePatch({ defaultModel: 'x'.repeat(81) }).ok, false)
})

test('validatePatch 的选项来自 models.js', () => {
  for (const r of RATIOS) assert.equal(validatePatch({ defaultRatio: r }).ok, true, r)
  for (const r of TOOL_RESOLUTIONS) assert.equal(validatePatch({ defaultResolution: r }).ok, true, r)
  assert.deepEqual([...PATCHABLE], ['defaultModel', 'defaultRatio', 'defaultResolution', 'defaultCount', 'defaultStyle', 'lockDefaults'])
})

test('defaultStyle 只收 auto / off / 已知风格，中文别名归一化', () => {
  for (const s of ['auto', 'off', 'cinematic', 'portrait', '深海', '人像']) {
    assert.equal(validatePatch({ defaultStyle: s }).ok, true, s)
  }
  assert.equal(validatePatch({ defaultStyle: '深海' }).values.defaultStyle, 'deepsea')
  assert.equal(validatePatch({ defaultStyle: '人像' }).values.defaultStyle, 'portrait')
  assert.equal(validatePatch({ defaultStyle: '不存在的风格' }).ok, false)
})

test('writePatchConfig 只改目标行，留备份，其他字段原样', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, FIXTURE, 'utf8')

  const res = writePatchConfig(file, { defaultModel: 'Seedream 5.0 Flash', defaultCount: 2 })
  assert.equal(res.ok, true)
  assert.deepEqual(res.changed.sort(), ['defaultCount', 'defaultModel'])
  assert.deepEqual(res.missing, [])
  assert.equal(res.backup, file + '.bak')
  assert.equal(fs.readFileSync(res.backup, 'utf8'), FIXTURE)

  const after = fs.readFileSync(file, 'utf8')
  assert.match(after, /^ {8}defaultModel: 'Seedream 5\.0 Flash' {2}# 便宜点换 Flash$/m)
  assert.match(after, /^ {8}defaultCount: 2$/m)
  assert.match(after, /^ {8}cdpPort: 9335$/m)
  assert.match(after, /^ {8}defaultRatio: '智能'$/m)
  assert.equal(after.split('\n').length, FIXTURE.split('\n').length)

  // 同一个值再写一次：不改、不建新备份
  const again = writePatchConfig(file, { defaultModel: 'Seedream 5.0 Flash' })
  assert.equal(again.ok, true)
  assert.deepEqual(again.changed, [])
  assert.equal(fs.readFileSync(file, 'utf8'), after)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('writePatchConfig 读不到文件时给错误，不抛', () => {
  const res = writePatchConfig(path.join(tmpDir(), 'nope.yml'), { defaultModel: 'x' })
  assert.equal(res.ok, false)
  assert.match(res.error, /读不到/)
})

test('writePatchConfig 保留 CRLF 行尾', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, FIXTURE.replace(/\n/g, '\r\n'), 'utf8')
  const res = writePatchConfig(file, { defaultRatio: '9:16' })
  assert.equal(res.ok, true)
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.includes('\r\n'))
  assert.match(after, /defaultRatio: '9:16'/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createSettings：合法值写盘 + 立刻生效', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, FIXTURE, 'utf8')

  const settings = createSettings({
    rawConfig: { enabled: true, defaultModel: 'Seedream 5.5' },
    patchPath: file,
    resolve: resolveConfig,
  })
  assert.equal(settings.get().defaultCount, 1)
  assert.equal(settings.get().defaultModel, 'Seedream 5.5')

  const out = settings.update({ defaultModel: 'Seedream 5.0 Lite', defaultCount: 3, defaultResolution: '4K' })
  assert.equal(out.ok, true)
  assert.equal(out.persisted, true)
  assert.equal(out.warning, '')
  assert.equal(out.config.defaultModel, 'Seedream 5.0 Lite')
  assert.equal(out.config.defaultCount, 3)
  assert.equal(out.config.defaultResolution, '4K')
  assert.equal(settings.get().defaultModel, 'Seedream 5.0 Lite')
  assert.deepEqual(settings.last().applied.sort(), ['defaultCount', 'defaultModel', 'defaultResolution'])
  assert.equal(settings.last().persisted, true)

  const onDisk = fs.readFileSync(file, 'utf8')
  assert.match(onDisk, /defaultModel: 'Seedream 5\.0 Lite'/)
  assert.match(onDisk, /defaultCount: 3$/m)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('createSettings：写盘失败也算生效，但带 warning', () => {
  const settings = createSettings({
    rawConfig: { enabled: true },
    patchPath: path.join(tmpDir(), 'missing.yml'),
    resolve: resolveConfig,
  })
  const out = settings.update({ defaultModel: 'Seedream 5.5', defaultCount: 2 })
  assert.equal(out.ok, true)
  assert.equal(out.persisted, false)
  assert.match(out.warning, /重启 DSH 后会退回旧值/)
  assert.equal(settings.get().defaultCount, 2)
  assert.equal(settings.last().persisted, false)
})

test('createSettings：非法值不生效，报错原样带回', () => {
  const settings = createSettings({
    rawConfig: { enabled: true, defaultRatio: '智能' },
    patchPath: path.join(tmpDir(), 'x.yml'),
    resolve: resolveConfig,
  })
  const out = settings.update({ defaultRatio: '5:4' })
  assert.equal(out.ok, false)
  assert.equal(out.errors.length, 1)
  assert.equal(settings.get().defaultRatio, '智能')
  assert.equal(settings.last(), null)
})
