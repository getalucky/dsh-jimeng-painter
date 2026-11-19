#!/usr/bin/env node
/**
 * 即梦网页生图 · 命令行入口。
 *
 * 用法：
 *   node tools/paint.mjs "一只戴草帽的橘猫"
 *   node tools/paint.mjs "..." --model "Seedream 5.0 Pro" --ratio 3:4 --resolution 2K --count 1 --out "D:\out"
 *   echo '{"prompt":"...","model":"Seedream 5.5"}' | node tools/paint.mjs --stdin-json --json
 */
import path from 'node:path'
import { JimengBridge, DEFAULT_CDP_PORT, DEFAULT_TIMEOUT_MS, defaultProfileDir } from '../lib/bridge.mjs'
import { composePrompt } from '../lib/prompt.mjs'

const argv = process.argv.slice(2)
const positional = []
const opts = {
  out: '',
  model: '',
  ratio: '',
  resolution: '',
  count: 1,
  cdp: DEFAULT_CDP_PORT,
  profile: defaultProfileDir(),
  edge: '',
  timeout: DEFAULT_TIMEOUT_MS,
  json: false,
  stdinJson: false,
  preview: false,
  style: '',
  dryRun: process.env.JIMENG_DRY_RUN === '1',
}

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  switch (arg) {
    case '--out': opts.out = argv[++i]; break
    case '--model': opts.model = argv[++i]; break
    case '--ratio': opts.ratio = argv[++i]; break
    case '--resolution': opts.resolution = argv[++i]; break
    case '--count': opts.count = Number(argv[++i]); break
    case '--cdp': opts.cdp = Number(argv[++i]); break
    case '--profile': opts.profile = path.resolve(argv[++i]); break
    case '--edge': opts.edge = argv[++i]; break
    case '--timeout': opts.timeout = Number(argv[++i]); break
    case '--style': opts.style = argv[++i]; break
    case '--preview': opts.preview = true; break
    case '--dry-run': opts.dryRun = true; break
    case '--stdin-json': opts.stdinJson = true; break
    case '--json': opts.json = true; break
    case '-h': case '--help':
      console.log('用法: node tools/paint.mjs "<提示词>" [--model 模型名] [--ratio 3:4] [--resolution 2K] [--count 1] [--out 目录] [--style 风格] [--preview] [--json]')
      console.log('   或: echo \'{"prompt":"...","style":"deepsea"}\' | node tools/paint.mjs --stdin-json --json')
      console.log('风格: auto / off / cinematic / portrait / film / guofeng / illustration / anime / cyber / product / deepsea / ink')
      process.exit(0)
    default:
      if (arg.startsWith('--')) throw new Error('未知参数: ' + arg)
      positional.push(arg)
  }
}

let req = {
  prompt: opts.promptArg || positional.join(' '),
  model: opts.model,
  ratio: opts.ratio,
  resolution: opts.resolution,
  count: opts.count,
  outDir: opts.out || path.resolve(process.cwd(), 'jimeng-images'),
  timeoutMs: opts.timeout,
  cdpPort: opts.cdp,
  profileDir: opts.profile,
  edgeExe: opts.edge,
  style: opts.style,
  preview: opts.preview,
  dryRun: opts.dryRun,
}

if (opts.stdinJson) {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw) {
    const j = JSON.parse(raw)
    req = {
      prompt: j.prompt ?? req.prompt,
      model: j.model ?? req.model,
      ratio: j.ratio ?? req.ratio,
      resolution: j.resolution ?? req.resolution,
      count: j.count ?? req.count,
      outDir: j.outDir ?? j.out_dir ?? req.outDir,
      timeoutMs: j.timeoutMs ?? j.timeout_ms ?? req.timeoutMs,
      cdpPort: j.cdpPort ?? j.cdp_port ?? req.cdpPort,
      profileDir: j.profileDir ?? j.profile_dir ?? req.profileDir,
      edgeExe: j.edgeExe ?? j.edge_exe ?? req.edgeExe,
      style: j.style ?? req.style,
      preview: j.preview === true || j.preview_only === true || req.preview,
      dryRun: j.dryRun === true || j.dry_run === true || req.dryRun,
    }
  }
}

if (!req.prompt || !String(req.prompt).trim()) {
  const msg = '缺少提示词'
  if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }))
  else console.error(msg + '。用法: node tools/paint.mjs "<提示词>"')
  process.exit(2)
}

let finalPrompt = String(req.prompt).trim()
let promptInfo = null
if (req.style || req.preview) {
  const composed = composePrompt({ prompt: finalPrompt, style: req.style || 'auto' })
  finalPrompt = composed.text
  promptInfo = {
    prompt: composed.text,
    style: composed.style.label,
    styleId: composed.style.id,
    promptLength: composed.length,
    warnings: composed.warnings,
    notes: composed.notes,
  }
  if (req.preview) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: true, preview: true, ...promptInfo }, null, 2))
    } else {
      console.log(`提示词预览（${composed.style.label}，${composed.length} 字）：`)
      console.log(composed.text)
      for (const note of composed.notes) console.log('说明：' + note)
      for (const warning of composed.warnings) console.log('提醒：' + warning)
    }
    process.exit(0)
  }
}

const bridge = new JimengBridge({
  port: req.cdpPort,
  profileDir: req.profileDir,
  edgeExe: req.edgeExe,
  timeoutMs: req.timeoutMs,
})

try {
  const result = await bridge.generate({
    prompt: finalPrompt,
    model: req.model,
    ratio: req.ratio,
    resolution: req.resolution,
    count: Number(req.count) || 1,
    outDir: path.resolve(req.outDir),
    dryRun: req.dryRun,
  })
  if (promptInfo) Object.assign(result, promptInfo)
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2))
  } else if (result.dryRun) {
    console.log('✅ 预演完成：' + JSON.stringify(result.state))
  } else {
    console.log(`✅ 即梦出图完成（${result.seconds.toFixed(1)}s，${result.model}）`)
    for (const file of result.files) console.log('  ' + file)
  }
  process.exitCode = result.ok ? 0 : 1
} catch (e) {
  if (opts.json) console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }, null, 2))
  else console.error('❌ ' + (e?.message || e))
  process.exitCode = 1
} finally {
  bridge.close()
  // CDP 的 WebSocket 在个别 Node 版本会把事件循环挂住；CLI 输出写完就退出。
  setTimeout(() => process.exit(process.exitCode ?? 0), 120)
}
