/**
 * 设置页的「保存」落到哪儿：写回插件自己的 cordis.patch.yml。
 *
 * DSH 没有给第三方插件通用的设置表单 API，插件的配置就是 bundle patch 里的 config。
 * 所以这里做两件事：
 *  1. 校验白名单里的四个默认值（模型 / 比例 / 清晰度 / 张数）；
 *  2. 只改对应那几行的值 —— 缩进、注释、其他字段全部原样保留，
 *     写之前留 .bak，写之后回读校验，不对就还原。
 */
import fs from 'node:fs'
import path from 'node:path'
import { RATIOS, TOOL_RESOLUTIONS } from './models.js'
import { describeStyles, normalizeStyleId } from './prompt.mjs'

export const PATCHABLE = ['defaultModel', 'defaultRatio', 'defaultResolution', 'defaultCount', 'defaultStyle', 'lockDefaults']
export const COUNT_MIN = 1
export const COUNT_MAX = 4

/** YAML 单引号标量：内部的 ' 要写成 ''。 */
export function yamlScalar(value) {
  return "'" + String(value).replace(/'/g, "''") + "'"
}

/** 数字和布尔原样写（张数写成 1 而不是 '1'），其他一律加引号。 */
export function yamlValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return yamlScalar(value)
}

/** 取一行里「值」后面的部分（多半是行尾注释），拿不到就返回空串。 */
function tailAfterValue(rest) {
  if (rest.startsWith("'")) {
    let i = 1
    while (i < rest.length) {
      if (rest[i] === "'") {
        if (rest[i + 1] === "'") { i += 2; continue }
        return rest.slice(i + 1)
      }
      i++
    }
    return ''
  }
  if (rest.startsWith('"')) {
    let i = 1
    while (i < rest.length) {
      if (rest[i] === '\\') { i += 2; continue }
      if (rest[i] === '"') return rest.slice(i + 1)
      i++
    }
    return ''
  }
  const hash = rest.search(/\s#/)
  return hash >= 0 ? rest.slice(hash) : ''
}

/** 把 `  defaultModel: '旧值'  # 注释` 换成新值，其他字符一个不动。 */
export function replaceLineValue(line, key, value) {
  const m = /^([ \t]*)([A-Za-z0-9_-]+):([ \t]*)([\s\S]*)$/.exec(line)
  if (!m) return null
  return m[1] + key + ':' + (m[3] || ' ') + yamlValue(value) + tailAfterValue(m[4])
}

/**
 * 校验一次设置页提交。只认白名单字段，其他字段忽略并回报。
 * @returns {{ok: boolean, errors: string[], values: Record<string,string>, ignored: string[]}}
 */
export function validatePatch(input) {
  const errors = []
  const values = {}
  const ignored = []
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['请求体必须是 JSON 对象'], values, ignored }
  }
  for (const key of Object.keys(input)) {
    if (!PATCHABLE.includes(key)) ignored.push(key)
  }
  for (const key of PATCHABLE) {
    if (!(key in input)) continue
    const raw = input[key]
    if (key === 'lockDefaults') {
      if (typeof raw === 'boolean') { values[key] = raw; continue }
      const text = String(raw).trim().toLowerCase()
      if (text === 'true' || text === 'false') { values[key] = text === 'true'; continue }
      errors.push('lockDefaults 必须是 true 或 false')
      continue
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') {
      errors.push(`${key} 必须是字符串`)
      continue
    }
    // 控制字符（含换行）会破坏 YAML 行结构，直接抹平。
    const text = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
    if (!text) {
      errors.push(`${key} 不能为空`)
      continue
    }
    if (text.length > 80) {
      errors.push(`${key} 太长（最多 80 字）`)
      continue
    }
    if (key === 'defaultRatio' && !RATIOS.includes(text)) {
      errors.push(`比例不支持：${text}（可选 ${RATIOS.join('、')}）`)
      continue
    }
    if (key === 'defaultResolution' && !TOOL_RESOLUTIONS.includes(text)) {
      errors.push(`清晰度不支持：${text}（可选 ${TOOL_RESOLUTIONS.join('、')}）`)
      continue
    }
    if (key === 'defaultCount') {
      const n = Number(text)
      if (!Number.isInteger(n) || n < COUNT_MIN || n > COUNT_MAX) {
        errors.push(`张数必须是 ${COUNT_MIN}-${COUNT_MAX} 的整数`)
        continue
      }
      values[key] = n
      continue
    }
    if (key === 'defaultStyle') {
      const id = normalizeStyleId(text)
      if (!id) {
        errors.push(`风格不支持：${text}（可选 auto、off 或 ${describeStyles()}）`)
        continue
      }
      values[key] = id
      continue
    }
    values[key] = text
  }
  if (errors.length) return { ok: false, errors, values, ignored }
  if (!Object.keys(values).length) {
    return { ok: false, errors: [`没有可写的字段（只支持 ${PATCHABLE.join('、')}）`], values, ignored }
  }
  return { ok: true, errors: [], values, ignored }
}

/**
 * 把 values 写回 patch 文件。原子写 + 备份 + 回读校验。
 * @returns {{ok: boolean, changed: string[], missing: string[], backup: string, error?: string}}
 */
export function writePatchConfig(patchPath, values) {
  const keys = Object.keys(values || {}).filter((k) => PATCHABLE.includes(k))
  if (!keys.length) return { ok: true, changed: [], missing: [], backup: '' }

  let raw
  try {
    raw = fs.readFileSync(patchPath, 'utf8')
  } catch (e) {
    return { ok: false, changed: [], missing: keys, backup: '', error: `读不到 ${path.basename(patchPath)}：${e?.message || e}` }
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  const lines = raw.split(/\r?\n/)
  const changed = []
  const missing = []

  for (const key of keys) {
    const hit = new RegExp('^[ \\t]*' + key + ':[ \\t]*')
    const idx = lines.findIndex((line) => hit.test(line))
    if (idx < 0) { missing.push(key); continue }
    const next = replaceLineValue(lines[idx], key, values[key])
    if (!next) { missing.push(key); continue }
    if (next !== lines[idx]) {
      lines[idx] = next
      changed.push(key)
    }
  }

  if (!changed.length) return { ok: true, changed, missing, backup: '' }

  const backup = patchPath + '.bak'
  try {
    fs.writeFileSync(backup, raw, 'utf8')
  } catch (e) {
    return { ok: false, changed: [], missing, backup: '', error: '写备份失败：' + (e?.message || e) }
  }

  const tmp = `${patchPath}.tmp-${process.pid}`
  try {
    fs.writeFileSync(tmp, lines.join(eol), 'utf8')
    fs.renameSync(tmp, patchPath)
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    try { fs.writeFileSync(patchPath, raw, 'utf8') } catch { /* ignore */ }
    return { ok: false, changed: [], missing, backup: '', error: '写配置失败：' + (e?.message || e) }
  }

  // 回读校验：行数没变，且每个改过的键带着新值。
  let after = ''
  try { after = fs.readFileSync(patchPath, 'utf8') } catch { /* ignore */ }
  const afterLines = after.split(/\r?\n/)
  const bad = changed.filter((key) => !afterLines.some((line) => line.includes(key + ':') && line.includes(yamlValue(values[key]))))
  if (!after || afterLines.length !== lines.length || bad.length) {
    try { fs.writeFileSync(patchPath, raw, 'utf8') } catch { /* ignore */ }
    return { ok: false, changed: [], missing, backup: '', error: '回读校验没通过（行数或值不对），已还原原文件' }
  }

  return { ok: true, changed, missing, backup }
}

/**
 * 运行期的设置簿：内存里立刻生效，同时尽量写回 patch 文件。
 * 写文件失败不算失败 —— 这次照样按新值跑，只是重启 DSH 后会退回旧值。
 */
export function createSettings({ rawConfig, patchPath, resolve, log }) {
  const base = rawConfig && typeof rawConfig === 'object' ? { ...rawConfig } : {}
  const file = path.basename(patchPath)
  let overrides = {}
  let last = null

  return {
    get file() { return file },
    get path() { return patchPath },
    /** 合并后的原始配置（未归一化）。 */
    raw() { return { ...base, ...overrides } },
    /** 给工具用的归一化配置。 */
    get() { return resolve({ ...base, ...overrides }) },
    last() { return last },
    update(input) {
      const checked = validatePatch(input)
      if (!checked.ok) return { ok: false, errors: checked.errors, ignored: checked.ignored }
      const write = writePatchConfig(patchPath, checked.values)
      overrides = { ...overrides, ...checked.values }
      const config = resolve({ ...base, ...overrides })
      last = {
        at: new Date().toISOString(),
        applied: Object.keys(checked.values),
        persisted: write.ok,
        error: write.ok ? '' : write.error,
      }
      if (!write.ok) log?.(`[dsh-jimeng-painter] 设置已生效但没写进 ${file}：${write.error}`)
      return {
        ok: true,
        config,
        applied: Object.keys(checked.values),
        ignored: checked.ignored,
        persisted: write.ok,
        warning: write.ok
          ? ''
          : `本次已经按新设置生效，但没能写进 ${file}（重启 DSH 后会退回旧值）：${write.error}`,
        backup: write.backup || '',
        missing: write.missing || [],
      }
    },
  }
}
