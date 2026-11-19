/**
 * dsh-jimeng-painter —— 把即梦网页的生图能力接进 DSH。
 *
 * 特点是模型可选：即梦网页上不同 Seedream/ImageMax 模型的价格不同，
 * 工具参数 model 直接对应页面下拉框里的模型名。
 *
 * 架构：插件是薄壳，真正干活的是 tools/paint.mjs 独立 node 子进程；
 * 用 Edge 独立 profile 的 CDP 驱动页面，不依赖公开 API、不需要 API Key。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveRuntime } from './resolve-node.mjs'
import { defaultProfileDir, status as bridgeStatus } from './bridge.mjs'
import { MODELS, MODEL_NAMES, RATIOS, TOOL_RESOLUTIONS } from './models.js'
import { composePrompt, describeStyles, normalizeStyleId } from './prompt.mjs'
import { COUNT_MAX, COUNT_MIN, createSettings } from './settings.mjs'
import { registerWebApi } from './webapi.js'

export const name = 'dsh-jimeng-painter'

/** 需要 DSH 的工具注册表与会话工作目录。 */
export const inject = ['tools', 'workingDirectory']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAINT_MJS = path.join(HERE, '..', 'tools', 'paint.mjs')
/** 设置页保存到哪儿：插件自己的 bundle patch（DSH 就是从这里读 config 的）。 */
const PATCH_FILE = path.join(HERE, '..', 'cordis.patch.yml')

const DEFAULTS = {
  enabled: true,
  cdpPort: 9335,
  edgeExe: '',
  profileDir: '',
  timeoutMs: 300000,
  outSubdir: 'jimeng-images',
  defaultModel: 'Seedream 5.5',
  defaultRatio: '智能',
  defaultResolution: '1.5K',
  defaultCount: 1,
  defaultStyle: 'auto',
  // 打开后，工具调用里的 model/ratio/resolution/count/style 一律不作数，只认设置页。
  lockDefaults: false,
}

export function resolveConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d)
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d)
  const int = (v, d, lo, hi) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= lo && n <= hi ? n : d
  }
  return {
    enabled: c.enabled === undefined ? DEFAULTS.enabled : Boolean(c.enabled),
    cdpPort: num(c.cdpPort, DEFAULTS.cdpPort),
    edgeExe: str(c.edgeExe, DEFAULTS.edgeExe),
    profileDir: str(c.profileDir, DEFAULTS.profileDir),
    timeoutMs: num(c.timeoutMs, DEFAULTS.timeoutMs),
    outSubdir: str(c.outSubdir, DEFAULTS.outSubdir),
    defaultModel: str(c.defaultModel, DEFAULTS.defaultModel),
    defaultRatio: str(c.defaultRatio, DEFAULTS.defaultRatio),
    defaultResolution: str(c.defaultResolution, DEFAULTS.defaultResolution),
    defaultCount: int(c.defaultCount, DEFAULTS.defaultCount, COUNT_MIN, COUNT_MAX),
    defaultStyle: normalizeStyleId(c.defaultStyle) || DEFAULTS.defaultStyle,
    lockDefaults: c.lockDefaults === true,
  }
}

function runPaint(runtime, payload, opts) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => { if (!settled) { settled = true; resolve(value) } }
    let child
    try {
      child = spawn(runtime.file, [PAINT_MJS, '--stdin-json', '--json'], {
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      finish({ ok: false, error: '启动 node 子进程失败: ' + (e?.message || e) })
      return
    }

    const out = []
    const err = []
    child.stdout.on('data', (d) => out.push(d))
    child.stderr.on('data', (d) => err.push(d))

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: `即梦生成超时（>${Math.round(opts.timeoutMs / 1000)}s）` })
    }, opts.timeoutMs + 30000)

    const onAbort = () => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: '调用被取消' })
    }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: 'node 子进程错误: ' + (e?.message || e) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8').trim()
      const stderr = Buffer.concat(err).toString('utf8').trim()
      const start = stdout.indexOf('{')
      const jsonText = stdout.startsWith('{') ? stdout : (start >= 0 ? stdout.slice(start) : '')
      try {
        finish(JSON.parse(jsonText))
      } catch {
        finish({ ok: false, error: (stderr || stdout || '即梦生成失败（无输出）').slice(0, 1200) })
      }
    })

    try {
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, error: '写入子进程失败: ' + (e?.message || e) })
    }
  })
}

const MODEL_HINT = MODELS.map((m) => `${m.name}（${m.note}）`).join('、')

const PAINT_DESCRIPTION = [
  '使用即梦网页版生成图片，直接返回下载到本地的原图路径。',
  '支持选择即梦网页里的生图模型：不同模型消耗积分不同，按用户要求选；不指定时用插件默认模型。',
  '不会自动更换模型：如果模型在页面上找不到，或该模型不支持所选比例/清晰度，会直接报错并停止，不会改用其他模型生成。',
  '可用模型：' + MODEL_HINT + '。',
  '提示词会按 style 做镜头、景别、机位、构图、光线和色彩编排；style=off 时原样提交。',
  '设置页打开「锁定默认值」后，model / ratio / resolution / count / style 这些参数一律不生效，只认设置页。',
  'preview=true 只返回最终提示词，不启动 Edge、不消耗积分；花积分前可先用它确认。',
  '内置风格：' + describeStyles() + '。',
  '即梦网页没有公开 API；插件用独立 Edge profile 的 CDP 驱动页面，首次登录由用户扫码完成。',
  '适用：插画、人像、壁纸、海报、头像、场景图。返回后可用 read_image 展示给用户。',
].join('\n')

const PAINT_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: '生图描述。写清主体、动作、场景，以及图上要出现的文字；镜头和风格可以交给 style/lens 等参数补。',
    },
    style: {
      type: 'string',
      description: `风格包；不填用设置页默认（当前 ${DEFAULTS.defaultStyle}）。auto 按提示词自动选，off 原样送即梦。可选：auto、off、${describeStyles()}。`,
    },
    lens: {
      type: 'string',
      description: '覆盖风格默认镜头，可写 key 或中文名，例如 wide-24 / portrait-85 / 50mm / 85mm 人像 / 微距。',
    },
    shot: {
      type: 'string',
      description: '覆盖景别：closeup / medium-close / medium / full / wide / detail，也可写 特写 / 近景 / 中景 / 全身 / 远景 / 局部细节。',
    },
    angle: {
      type: 'string',
      description: '覆盖机位：eye-level / low / high / three-quarter / over-shoulder / pov / bird-eye / side，也可写 平视 / 仰拍 / 俯拍 / 侧脸 / 过肩 / 第一人称 / 鸟瞰。',
    },
    composition: {
      type: 'string',
      description: '覆盖构图，最多 2 个，用逗号分隔。可选：rule-of-thirds / foreground-bokeh / negative-space / centered / symmetry / leading-lines / diagonal / s-curve / frame-in-frame / full-bleed / candid，也可写中文。',
    },
    lighting: {
      type: 'string',
      description: '覆盖光线：golden-hour / blue-hour / window / overcast / tyndall / softbox / practical / neon / mixed / rembrandt / butterfly / loop / rim / front / side-45 / side-90 / hard / soft / top / bottom，也可写中文。',
    },
    preview: {
      type: 'boolean',
      description: '只返回编排后的最终提示词，不打开即梦、不消耗积分。',
    },
    model: {
      type: 'string',
      description: `即梦网页生图模型名；不填就用设置页里的默认模型（当前 ${DEFAULTS.defaultModel}）。只有用户明确指定模型时才填，不要为了避开参数问题自行换模型。可选：${MODEL_NAMES.join('、')}。名字必须和页面上完全一致，设置页「即梦生图」可以刷新实时列表。不同模型价格不同。`,
    },
    ratio: {
      type: 'string',
      enum: RATIOS,
      description: `画面比例；不填就用设置页的默认值（当前 ${DEFAULTS.defaultRatio}）。`,
    },
    resolution: {
      type: 'string',
      enum: TOOL_RESOLUTIONS,
      description: `清晰度；不填就用设置页的默认值（当前 ${DEFAULTS.defaultResolution}）。2K/4K 消耗更多积分。`,
    },
    count: {
      type: 'integer',
      minimum: COUNT_MIN,
      maximum: COUNT_MAX,
      description: `生成张数 ${COUNT_MIN}-${COUNT_MAX}；不填就用设置页的默认值（当前 ${DEFAULTS.defaultCount}）。`,
    },
    out_dir: {
      type: 'string',
      description: '输出目录（绝对路径，可选）。默认是当前会话工作区下的 jimeng-images/。',
    },
    timeout_ms: {
      type: 'number',
      description: '等待超时毫秒数（可选，默认 300000）。',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const PAINT_OUTPUT = {
  schema: {
    type: 'object',
    properties: {
      files: { type: 'array', items: { type: 'string' }, description: '生成图片的本地绝对路径' },
      urls: { type: 'array', items: { type: 'string' }, description: '即梦 CDN 上的原图地址（有时效）' },
      model: { type: 'string', description: '实际使用的模型' },
      format: { type: 'string', description: '页面上的比例/清晰度' },
      count: { type: 'number', description: '实际得到的张数' },
      seconds: { type: 'number', description: '耗时（秒）' },
      dryRun: { type: 'boolean', description: '是否只预演没有提交' },
      preview: { type: 'boolean', description: '是否只返回提示词预览' },
      prompt: { type: 'string', description: '实际送进即梦的最终提示词' },
      style: { type: 'string', description: '实际使用的风格名' },
      styleId: { type: 'string', description: '实际使用的风格 id；off 表示原样提交' },
      promptLength: { type: 'number', description: '最终提示词字数' },
      warnings: { type: 'array', items: { type: 'string' }, description: '提示词编排提醒' },
      notes: { type: 'array', items: { type: 'string' }, description: '编排说明' },
    },
    required: ['files'],
    additionalProperties: false,
  },
  render: (_args, value) => {
    if (value.preview) {
      const lines = [`提示词预览（${value.style || '未优化'}，${Number(value.promptLength || 0)} 字）：`, value.prompt || '']
      if (Array.isArray(value.notes) && value.notes.length) lines.push('说明：' + value.notes.join('；'))
      if (Array.isArray(value.warnings) && value.warnings.length) lines.push('提醒：' + value.warnings.join('；'))
      return [{ type: 'text', text: lines.join('\n') }]
    }
    if (value.dryRun) return [{ type: 'text', text: '即梦预演完成：' + JSON.stringify(value.state || {}) }]
    if (!Array.isArray(value.files) || !value.files.length) return [{ type: 'text', text: '即梦没有返回图片' }]
    const lines = [`即梦出图完成（${Number(value.seconds || 0).toFixed(1)}s，${value.model || '模型未知'}）：`]
    for (const file of value.files) lines.push('  ' + file)
    if (value.style) lines.push(`风格：${value.style}`)
    if (Array.isArray(value.warnings) && value.warnings.length) lines.push('提示词提醒：' + value.warnings.join('；'))
    return [{ type: 'text', text: lines.join('\n') }]
  },
}

const STATUS_DESCRIPTION = [
  '检查即梦网页生图链路：Edge 调试端口、即梦生成页、编辑器、当前模型。',
  '报错时先用它排障。',
].join('\n')

const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
})()

export function apply(ctx, rawConfig) {
  const initial = resolveConfig(rawConfig)
  if (!initial.enabled) return

  let runtime
  try {
    runtime = resolveRuntime(process.env.DSH_HOME)
  } catch (e) {
    console.error('[dsh-jimeng-painter] ' + (e?.message || e))
    return
  }

  // 设置页改的值立刻进内存（本次运行就生效），再尽量写回 cordis.patch.yml（重启后还在）。
  const settings = createSettings({
    rawConfig,
    patchPath: PATCH_FILE,
    resolve: resolveConfig,
    log: (line) => console.error(line),
  })
  const bridgeOpts = () => {
    const c = settings.get()
    return { port: c.cdpPort, profileDir: c.profileDir || defaultProfileDir(), edgeExe: c.edgeExe }
  }

  // 界面接口：webServer 是可选服务，不能写进 inject（老宿主没有会整个 apply 卡住）。
  const disposers = []
  ctx.on?.('dispose', () => {
    for (const d of disposers.splice(0)) { try { d() } catch { /* ignore */ } }
  })
  const mountApi = (c) => {
    try {
      const api = registerWebApi(c, {
        settings,
        bridgeOpts,
        version: VERSION,
        log: (line) => console.error(line),
      })
      if (api) disposers.push(() => api.dispose())
    } catch (e) {
      console.error('[dsh-jimeng-painter] 设置页接口挂载失败 ' + String(e?.message || e).slice(0, 200))
    }
  }
  try {
    if (typeof ctx.inject === 'function') ctx.inject(['webServer'], mountApi)
    else if (ctx.webServer) mountApi(ctx)
  } catch (e) {
    console.error('[dsh-jimeng-painter] 等待 webServer 失败 ' + String(e?.message || e).slice(0, 200))
  }

  ctx.tools.register({
    name: 'jimeng_paint',
    description: PAINT_DESCRIPTION,
    parameters: PAINT_PARAMETERS,
    output: PAINT_OUTPUT,
    async execute(args, exec) {
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('prompt 不能为空')

      // 每次都重新取：设置页可能刚改过默认值。
      const config = settings.get()
      const locked = config.lockDefaults === true
      // 锁定时工具传什么都不作数，全部落到设置页的默认值。
      const pick = (value, fallback) => {
        if (locked || value == null) return fallback
        const text = String(value).trim()
        return text ? text : fallback
      }
      const styleInput = pick(args.style, config.defaultStyle)
      const composed = composePrompt({
        prompt,
        style: styleInput,
        // 锁定时连镜头/景别这些改写也一起忽略，保证出图和设置页完全一致。
        lens: locked ? undefined : args.lens,
        shot: locked ? undefined : args.shot,
        angle: locked ? undefined : args.angle,
        composition: locked ? undefined : args.composition,
        lighting: locked ? undefined : args.lighting,
      })
      const promptInfo = {
        prompt: composed.text,
        style: composed.style.label,
        styleId: composed.style.id,
        promptLength: composed.length,
        warnings: composed.warnings,
        notes: composed.notes,
      }

      if (args.preview === true) {
        return {
          files: [],
          preview: true,
          ...promptInfo,
          model: '',
          format: '',
          count: 0,
          seconds: 0,
        }
      }

      let outDir = args.out_dir
      if (!outDir) {
        const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
        outDir = path.join(cwd, config.outSubdir)
      }
      if (!path.isAbsolute(outDir)) throw new Error(`out_dir 必须是绝对路径：${outDir}`)

      const timeoutMs = Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : config.timeoutMs
      const countArg = Number(args.count)
      const wantCount = !locked && Number.isFinite(countArg) && countArg > 0 ? countArg : config.defaultCount
      const result = await runPaint(runtime, {
        prompt: composed.text,
        model: pick(args.model, config.defaultModel),
        ratio: pick(args.ratio, config.defaultRatio),
        resolution: pick(args.resolution, config.defaultResolution),
        count: wantCount,
        outDir,
        timeoutMs,
        cdpPort: config.cdpPort,
        profileDir: config.profileDir || defaultProfileDir(),
        edgeExe: config.edgeExe,
      }, { signal: exec.signal, timeoutMs })

      if (!result?.ok) throw new Error(result?.error || '即梦生成失败（无返回）')
      return {
        files: Array.isArray(result.files) ? result.files : [],
        urls: Array.isArray(result.urls) ? result.urls : [],
        model: String(result.model || ''),
        format: String(result.format || ''),
        count: Number(result.count) || 0,
        seconds: Number(result.seconds) || 0,
        ...promptInfo,
      }
    },
  })

  ctx.tools.register({
    name: 'jimeng_status',
    description: STATUS_DESCRIPTION,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          cdpAlive: { type: 'boolean' },
          port: { type: 'number' },
          profileDir: { type: 'string' },
          pageFound: { type: 'boolean' },
          editorReady: { type: 'boolean' },
          login: { type: 'boolean' },
          model: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
          modelsLive: { type: 'boolean', description: 'models 是不是从页面实时读到的' },
          modelsError: { type: 'string', description: '实时读取失败的原因；失败时 models 退回静态清单' },
          hint: { type: 'string' },
        },
        required: ['cdpAlive'],
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.hint || (value.cdpAlive ? '即梦在线' : '即梦离线'),
      }],
    },
    async execute() {
      return await bridgeStatus(bridgeOpts())
    },
  })
}

export default { name, inject, apply }
