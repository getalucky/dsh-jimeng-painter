/**
 * 提示词编排：把 agent 写的“主体描述”补成有镜头、构图、光线和风格锚点的完整提示词。
 *
 * 顺序按即梦/Seedream 更吃的自然语言权重来：
 *   画质/媒介 → 镜头 + 景别 + 机位 → 构图 → 主体 → 光线 → 色彩/材质/情绪 → 避免项
 *
 * 只做确定性的编排，不调模型；风格和镜头表分别放在 presets/styles.json、presets/frames.json。
 */
import fs from 'node:fs'

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./presets/${name}`, import.meta.url), 'utf8'))

export const FRAMES = load('frames.json')
export const STYLES = load('styles.json').styles
export const STYLE_IDS = STYLES.map((s) => s.id)
export const STYLE_MODES = ['auto', ...STYLE_IDS, 'off']
export const MAX_PROMPT_CHARS = 360

const STYLE_ALIASES = new Map()
for (const style of STYLES) {
  for (const alias of [style.id, style.label, ...(style.aliases || [])]) {
    STYLE_ALIASES.set(String(alias).trim().toLowerCase(), style)
  }
}

/** 把风格 id / 中文名 / 别名解析成风格对象；不认识返回 null。 */
export function resolveStyle(value) {
  const key = String(value ?? '').trim().toLowerCase()
  return key ? (STYLE_ALIASES.get(key) || null) : null
}

/** 设置页只存规范 id：auto / off / 风格 id。 */
export function normalizeStyleId(value) {
  const key = String(value ?? '').trim().toLowerCase()
  if (!key) return null
  if (key === 'auto') return 'auto'
  if (key === 'off' || key === 'none' || key === 'raw') return 'off'
  const style = resolveStyle(key)
  return style ? style.id : null
}

export function describeStyles() {
  return STYLES.map((s) => `${s.id}（${s.label}）`).join('、')
}

export function styleOptions() {
  return [
    { id: 'auto', label: '自动识别' },
    ...STYLES.map((s) => ({ id: s.id, label: s.label })),
    { id: 'off', label: '不优化（原样送即梦）' },
  ]
}

/** 这些媒介没有对应风格包；auto 时原样保留，避免电影/摄影词把原风格洗掉。 */
const FOREIGN_MEDIUM = /油画|像素|粘土|黏土|3D|三维|素描|版画|蜡笔|剪纸|拼贴|毛毡|乐高|低多边形|等距|黑白|单色|迪士尼|皮克斯/

const AUTO_RULES = [
  { id: 'ink', re: /水墨|宣纸|墨色|山水画|国画/ },
  { id: 'anime', re: /二次元|动漫|动画|赛璐璐|漫画|日系/ },
  { id: 'illustration', re: /绘本|插画|手绘|水彩|彩铅|涂鸦/ },
  { id: 'guofeng', re: /国风|古风|中式|汉服|仙侠|武侠|东方美学/ },
  { id: 'cyber', re: /赛博|霓虹|未来都市|机甲|科幻|蒸汽波/ },
  { id: 'product', re: /产品|商品|静物|包装|广告图|电商/ },
  { id: 'deepsea', re: /深海|海底|鲸|水母|生物荧光|海洋/ },
  { id: 'film', re: /胶片|复古|街拍|日常|生活感/ },
  { id: 'portrait', re: /人像|肖像|写真|女孩|男孩|自拍|头像|面部|少女|少年/ },
]

/** 没指定风格时，按提示词里的关键词挑一个；都没命中就走电影写实。 */
export function pickAutoStyle(prompt) {
  const text = String(prompt || '')
  for (const rule of AUTO_RULES) {
    if (rule.re.test(text)) return STYLES.find((s) => s.id === rule.id) || null
  }
  return STYLES.find((s) => s.id === 'cinematic') || STYLES[0]
}

function frameMap(kind) {
  const map = FRAMES[kind]
  if (!map || typeof map !== 'object') throw new Error(`缺少镜头目录：${kind}`)
  return map
}

/** 支持 key、中文 label、别名；例如 lens 的 portrait-85 / 85mm 人像。 */
export function resolveFrame(kind, value) {
  const map = frameMap(kind)
  const key = String(value ?? '').trim()
  if (!key) return null
  if (map[key]) return { id: key, ...map[key] }
  const lower = key.toLowerCase()
  for (const [id, item] of Object.entries(map)) {
    if (id.toLowerCase() === lower) return { id, ...item }
    if (String(item.label || '').trim() === key) return { id, ...item }
    if ((item.aliases || []).some((a) => String(a).trim().toLowerCase() === lower)) return { id, ...item }
    if ((item.keywords || []).some((k) => String(k).trim().toLowerCase() === lower)) return { id, ...item }
  }
  return null
}

function frameKeys(kind) {
  return Object.keys(frameMap(kind))
}

/** 提示词里已经写了这一类信息，就不要再叠风格默认值。 */
function mentions(kind, text) {
  const t = String(text || '')
  for (const item of Object.values(frameMap(kind))) {
    if ((item.keywords || []).some((k) => t.includes(k))) return true
  }
  if (kind === 'lens' && /\b(14|16|20|24|28|35|50|85|100|105|135|200)\s*(mm|毫米)\b/i.test(t)) return true
  return false
}

function one(kind, value, label) {
  const item = resolveFrame(kind, value)
  if (!item) throw new Error(`未知${label}：${value}。可选：${frameKeys(kind).join('、')}（也可写中文名）`)
  return item
}

function compositions(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，、+]/)
  const out = []
  for (const part of list) {
    const text = String(part ?? '').trim()
    if (!text) continue
    const item = one('composition', text, '构图')
    if (!out.some((x) => x.id === item.id)) out.push(item)
    if (out.length === 2) break
  }
  return out
}

const GLOBAL_AVOID = ['水印', '签名', '画面畸形']
const TRAILING = /[。.!！?？;；,，\s]+$/u

function unique(list) {
  const out = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  return out
}

function explicit(value) {
  if (value == null) return null
  if (Array.isArray(value)) return value.length ? value : null
  return String(value).trim() || null
}

/**
 * 编排最终提示词。
 *
 * @param {object} input
 * @param {string} input.prompt 主体描述（必填）
 * @param {string} [input.style] auto / off / 风格 id；默认 auto
 * @param {string} [input.lens] 覆盖风格默认镜头
 * @param {string} [input.shot] 覆盖景别
 * @param {string} [input.angle] 覆盖机位
 * @param {string|string[]} [input.composition] 覆盖构图，最多 2 个
 * @param {string} [input.lighting] 覆盖光线
 * @param {boolean} [input.optimize] false 等价于 style=off
 * @returns {{ok: boolean, text: string, style: {id: string, label: string}, optimized: boolean, length: number, maxChars: number, overLimit: boolean, warnings: string[], notes: string[], parts: object}}
 */
export function composePrompt(input = {}) {
  const raw = String(input.prompt ?? '').trim()
  if (!raw) throw new Error('prompt 不能为空')

  const requested = String(input.style ?? 'auto').trim()
  const mode = requested.toLowerCase()
  if (input.optimize === false || mode === 'off' || mode === 'none' || mode === 'raw') {
    return {
      ok: true,
      text: raw,
      style: { id: 'off', label: '不优化' },
      optimized: false,
      length: raw.length,
      maxChars: MAX_PROMPT_CHARS,
      overLimit: false,
      warnings: [],
      notes: [],
      parts: { subject: raw },
    }
  }

  const auto = mode === 'auto'
  if (auto && FOREIGN_MEDIUM.test(raw)) {
    return {
      ok: true,
      text: raw,
      style: { id: 'off', label: '保留原媒介' },
      optimized: false,
      length: raw.length,
      maxChars: MAX_PROMPT_CHARS,
      overLimit: false,
      warnings: [],
      notes: ['提示词里已有明确媒介，auto 不改写；需要风格请显式传 style'],
      parts: { subject: raw },
    }
  }

  const style = auto ? pickAutoStyle(raw) : resolveStyle(requested)
  if (!style) throw new Error(`未知风格：${requested}。可选：auto、off、${describeStyles()}`)

  const notes = []
  if (auto) notes.push(`按提示词自动选择风格：${style.label}`)

  const subject = raw.replace(TRAILING, '')
  const frame = []
  const parts = { medium: style.medium, subject }

  const lensArg = explicit(input.lens)
  const lens = lensArg || (mentions('lens', subject) ? null : style.lens)
  if (lens) {
    const item = one('lens', lens, '镜头')
    frame.push(item.phrase)
    parts.lens = item.id
  } else if (!lensArg && style.lens) {
    notes.push('提示词里已有镜头信息，跳过风格默认镜头')
  }

  const shotArg = explicit(input.shot)
  const shot = shotArg || (mentions('shot', subject) ? null : style.shot)
  if (shot) {
    const item = one('shot', shot, '景别')
    frame.push(item.phrase)
    parts.shot = item.id
  } else if (!shotArg && style.shot) {
    notes.push('提示词里已有景别信息，跳过风格默认景别')
  }

  const angleArg = explicit(input.angle)
  const angle = angleArg || (mentions('angle', subject) ? null : style.angle)
  if (angle) {
    const item = one('angle', angle, '机位')
    frame.push(item.phrase)
    parts.angle = item.id
  } else if (!angleArg && style.angle) {
    notes.push('提示词里已有视角信息，跳过风格默认视角')
  }

  const compArg = explicit(input.composition)
  const compValue = compArg || (mentions('composition', subject) ? null : style.composition)
  if (compValue) {
    const items = compositions(compValue)
    for (const item of items) frame.push(item.phrase)
    if (items.length) parts.composition = items.map((x) => x.id)
  } else if (!compArg && style.composition) {
    notes.push('提示词里已有构图信息，跳过风格默认构图')
  }

  const lightArg = explicit(input.lighting)
  const light = lightArg || (mentions('lighting', subject) ? null : style.lighting)
  let lighting = ''
  if (light) {
    const item = one('lighting', light, '光线')
    lighting = item.phrase
    parts.lighting = item.id
  } else if (!lightArg && style.lighting) {
    notes.push('提示词里已有光线信息，跳过风格默认光线')
  }

  const tail = unique([style.palette, style.texture, style.mood])
  const avoid = unique([...(style.avoid || []), ...GLOBAL_AVOID]).filter((x) => !subject.includes(x))

  const clauses = []
  if (style.medium) clauses.push(style.medium)
  if (frame.length) clauses.push(frame.join('，'))
  clauses.push(subject)
  if (lighting) clauses.push(lighting)
  if (tail.length) clauses.push(tail.join('，'))
  if (avoid.length) clauses.push('避免：' + avoid.join('、'))

  const text = clauses.map((c) => String(c).replace(/[。；;]+$/u, '')).join('。') + '。'
  const warnings = []
  if (text.length > MAX_PROMPT_CHARS) {
    warnings.push(`提示词偏长（${text.length} 字，建议 ≤${MAX_PROMPT_CHARS} 字），可能稀释重点`)
  }

  parts.frame = frame.join('，')
  parts.lightingText = lighting
  parts.tail = tail.join('，')
  parts.avoid = avoid.join('、')

  return {
    ok: true,
    text,
    style: { id: style.id, label: style.label },
    optimized: true,
    length: text.length,
    maxChars: MAX_PROMPT_CHARS,
    overLimit: text.length > MAX_PROMPT_CHARS,
    warnings,
    notes,
    parts,
  }
}
