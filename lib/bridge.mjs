/**
 * 即梦网页生图 · CDP 桥。
 *
 * 不碰官方 API 签名：用 Edge 自己的页面执行 fetch，让页面自动带 msToken；
 * 插件只负责点按钮、等结果、把原图下载到本地。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Cdp, listTargets, sleep, edgePath } from './cdp.mjs'
import { MODEL_NAMES, RATIOS, RESOLUTIONS } from './models.js'

export const DEFAULT_CDP_PORT = 9335
export const DEFAULT_TIMEOUT_MS = 300000
export const GEN_URL = 'https://jimeng.jianying.com/ai-tool/image/generate'

export function defaultProfileDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'jimeng-profile')
}

async function getJson(url, init, timeoutMs = 5000) {
  const r = await fetch(url, { ...(init || {}), signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`${url} ${r.status}`)
  return await r.json()
}

// 页面上的格式按钮文案可能是「智能比例 1.5K」或「3:4 2K」。
function formatMatches(current, ratio, resolution) {
  const text = String(current || '')
  if (ratio) {
    const want = ratio === '智能' ? '智能比例' : String(ratio)
    if (!text.includes(want)) return false
  }
  if (resolution && !text.includes(String(resolution))) return false
  return Boolean(ratio || resolution)
}

const PAGE_HELPERS = `
const __vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
const __clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
const __first = (el) => (el.innerText || '').trim().split('\\n')[0].trim()
const __modelName = (s) => __clean(s || '').replace(/\\s+(?:(?:限免|会员|免费).*|(?:\\d+(?:\\.\\d+)?\\s*)?(?:积分|元|\\/张).*)$/, '').trim()
`

const READ_STATE = `(() => {
  ${PAGE_HELPERS}
  const sel = [...document.querySelectorAll('[aria-label="模型"]')].find(__vis)
  const fmt = [...document.querySelectorAll('button')].filter(__vis)
    .find((b) => /(智能比例|\\d+:\\d+)/.test(b.innerText || '') && /(1\\.5K|2K|4K)/.test(b.innerText || ''))
  const text = document.body.innerText || ''
  return {
    model: __modelName(sel?.innerText || ''),
    format: __clean(fmt?.innerText || ''),
    login: /欢迎登录即梦/.test(text),
    generating: /生成中/.test(text),
    done: /生成完成/.test(text),
  }
})()`

const OPEN_MODEL = `(() => {
  ${PAGE_HELPERS}
  const el = [...document.querySelectorAll('[aria-label="模型"]')].find(__vis)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { open: el.getAttribute('aria-expanded') === 'true', x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`

const CLICK_MODEL = `(() => {
  ${PAGE_HELPERS}
  const el = [...document.querySelectorAll('[aria-label="模型"]')].find(__vis)
  if (!el) return false
  el.click()
  return true
})()`

const OPTION_POS = (name) => `(() => {
  ${PAGE_HELPERS}
  const opts = [...document.querySelectorAll('li[role="option"]')]
  const hit = opts.find((el) => __first(el) === ${JSON.stringify(name)})
  if (!hit) return { ok: false, names: opts.filter(__vis).map((el) => __first(el)) }
  // 列表比弹层高时，低处的模型在视口外，直接按坐标点会点空；先滚到中间。
  hit.scrollIntoView({ block: 'center', inline: 'nearest' })
  const r = hit.getBoundingClientRect()
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), name: __first(hit) }
})()`

// 模型弹层是否开着：即梦用的是自定义 lv-select，选项是 li[role="option"]。
const MODEL_POPUP_OPEN = `(() => {
  ${PAGE_HELPERS}
  return [...document.querySelectorAll('li[role="option"]')].filter(__vis).length > 0
})()`

// 读弹层里的所有选项。首行是模型名，价格是「60积分/张」这种异步刷出来的字样。
const READ_MODEL_OPTIONS = `(() => {
  ${PAGE_HELPERS}
  const sel = [...document.querySelectorAll('[aria-label="模型"]')].find(__vis)
  const opts = [...document.querySelectorAll('li[role="option"]')].filter(__vis)
  const rows = opts.map((el) => {
    const text = el.innerText || ''
    const lines = text.split('\\n').map((s) => s.trim()).filter(Boolean)
    const price = (text.match(/\\d+(?:\\.\\d+)?\\s*积分(?:\\/张)?/) || [''])[0]
    return { name: lines[0] || '', price, sub: price ? '' : (lines[1] || '') }
  })
  // 触发器的文字可能带价格；能对上某个选项名就取那个名字。
  const raw = __clean(sel ? sel.innerText : '')
  const current = rows.map((r) => r.name).find((n) => n && raw.startsWith(n))
    || raw.replace(/\\d+(?:\\.\\d+)?\\s*积分.*$/, '').trim()
  return { rows, current, expanded: sel ? sel.getAttribute('aria-expanded') === 'true' : null }
})()`

// 合成一个 Escape 事件：有些组件只监听 document 上的 keydown。
const ESCAPE_EVENT = `(() => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true })
  document.dispatchEvent(ev)
  return true
})()`

const FORMAT_POS = `(() => {
  ${PAGE_HELPERS}
  const btn = [...document.querySelectorAll('button')].filter(__vis)
    .find((b) => /(智能比例|\\d+:\\d+)/.test(b.innerText || '') && /(1\\.5K|2K|4K)/.test(b.innerText || ''))
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: __clean(btn.innerText) }
})()`

const TOOLTIP_POS = (text) => `(() => {
  ${PAGE_HELPERS}
  const pop = [...document.querySelectorAll('[role="tooltip"]')].find(__vis)
  if (!pop) return { ok: false, why: 'no-tooltip' }
  const hit = [...pop.querySelectorAll('*')].filter(__vis)
    .find((el) => __clean(el.innerText) === ${JSON.stringify(text)})
  if (!hit) return { ok: false, why: 'no-option', options: pop.innerText || '' }
  const r = hit.getBoundingClientRect()
  return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
})()`

const SET_PROMPT = (text) => `(async () => {
  ${PAGE_HELPERS}
  const ed = [...document.querySelectorAll('div.tiptap.ProseMirror,[contenteditable=true]')].find(__vis)
  if (!ed) return { ok: false, why: 'no-editor' }
  ed.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(ed)
  sel.removeAllRanges()
  sel.addRange(range)
  document.execCommand('insertText', false, ${JSON.stringify(text)})
  await new Promise((r) => setTimeout(r, 700))
  const btn = [...document.querySelectorAll('button[aria-label="生成"]')].filter(__vis).pop()
  return { ok: true, text: (ed.innerText || '').slice(0, 120), submit: !!btn, disabled: btn ? btn.disabled : null }
})()`

const SUBMIT_POS = `(() => {
  ${PAGE_HELPERS}
  const btn = [...document.querySelectorAll('button[aria-label="生成"]')].filter(__vis).pop()
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: btn.disabled }
})()`

const CLOSE_LOGIN = `(() => {
  ${PAGE_HELPERS}
  const candidates = [...document.querySelectorAll('button,div,span,i,svg')].filter(__vis)
  const aria = candidates.find((el) => (el.getAttribute('aria-label') || '') === '关闭')
  if (aria) { aria.click(); return 'aria' }
  const cls = candidates.find((el) => /close/i.test(String(el.className?.baseVal ?? el.className ?? '')))
  if (cls) { cls.click(); return 'class' }
  return 'none'
})()`

const LOGIN_OPEN = `(() => {
  ${PAGE_HELPERS}
  const phone = [...document.querySelectorAll('input')].find((el) => __vis(el) && /手机号/.test(el.getAttribute('placeholder') || ''))
  const text = document.body.innerText || ''
  return { open: !!phone || /欢迎登录即梦/.test(text) }
})()`

const ALL_IDS = `(() => {
  ${PAGE_HELPERS}
  const isResult = (img) => {
    let a = img.parentElement, k = 0
    while (a && k < 5) { if (String(a.className || '').includes('image-card-container')) return true; a = a.parentElement; k++ }
    return /aigc_resize(?:_mark)?:(?:360:360|640:640|0:0)/.test(img.src)
  }
  const imgs = [...document.querySelectorAll('img')]
    .filter((i) => i.src.includes('byteimg') && i.naturalWidth > 0 && isResult(i))
  return [...new Set(imgs.map((i) => i.src.split('/').pop().split('~')[0]))]
})()`

const POLL_IDS = (preIds) => `(() => {
  ${PAGE_HELPERS}
  const isResult = (img) => {
    let a = img.parentElement, k = 0
    while (a && k < 5) { if (String(a.className || '').includes('image-card-container')) return true; a = a.parentElement; k++ }
    return /aigc_resize(?:_mark)?:(?:360:360|640:640|0:0)/.test(img.src)
  }
  const pre = ${JSON.stringify(preIds)}
  const imgs = [...document.querySelectorAll('img')].filter((i) => {
    if (!i.src.includes('byteimg') || !i.naturalWidth || !isResult(i)) return false
    return pre.indexOf(i.src.split('/').pop().split('~')[0]) < 0
  })
  const ids = [...new Set(imgs.map((i) => i.src.split('/').pop().split('~')[0]))]
  const text = document.body.innerText || ''
  return {
    ids,
    n: ids.length,
    done: text.includes('生成完成'),
    generating: text.includes('生成中'),
    failed: text.includes('生成失败') || text.includes('积分不足') || text.includes('余额不足'),
  }
})()`

const ORIGINAL_URLS = (ids) => `(async () => {
  const uris = ${JSON.stringify(ids)}.map((id) => 'tos-cn-i-tb4s082cfz/' + id)
  const r = await fetch('/mweb/v1/get_image_by_uri?aid=513695&device_platform=web&region=CN&web_version=7.5.0&da_version=3.3.39', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uris }),
  })
  const j = await r.json()
  const out = {}
  for (const [k, v] of Object.entries(j.uri2image || {})) out[k.split('/').pop()] = v.image_url
  return out
})()`

export class JimengBridge {
  constructor(opts = {}) {
    this.port = Number(opts.port) > 0 ? Number(opts.port) : DEFAULT_CDP_PORT
    this.profileDir = opts.profileDir ? path.resolve(opts.profileDir) : defaultProfileDir()
    this.edgeExe = opts.edgeExe ? String(opts.edgeExe) : ''
    this.timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS
    // 提交后一直没有任何进展（既没「生成中」也没新图）时提前判失败，别干等到总超时。
    this.stallTimeoutMs = Math.min(90000, this.timeoutMs)
    this.cdp = null
    this.tab = null
  }

  async cdpAlive() {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1500) })
      return r.ok
    } catch {
      return false
    }
  }

  async ensureBrowser() {
    if (await this.cdpAlive()) return
    const exe = this.edgeExe || edgePath()
    if (!fs.existsSync(exe)) throw new Error(`找不到 Edge：${exe}`)
    fs.mkdirSync(this.profileDir, { recursive: true })
    const child = spawn(exe, [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--window-size=1440,1000',
      '--window-position=40,40',
      'about:blank',
    ], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()

    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (await this.cdpAlive()) return
      await sleep(500)
    }
    throw new Error(`Edge 调试端口未就绪：${this.port}`)
  }

  async openTab() {
    // 优先复用已经打开的即梦标签页；没有才新开。
    // 新开的标签页在首屏加载期间可能暂时不接受 CDP 命令，复用旧页更稳。
    const targets = await listTargets(this.port)
    const found = targets.find((t) => t.type === 'page' && (t.url || '').includes('jimeng.jianying.com'))
    if (found) return found
    const r = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(GEN_URL)}`, { method: 'PUT' })
    if (!r.ok) throw new Error(`打开即梦标签页失败：${r.status}`)
    return await r.json()
  }

  // ===== LOCAL-PATCH:生成页自检 START =====
  // 2026-11-23：标签页停在历史图详情 / 别的页面时，页面上没有输入框，
  //   后面 setPrompt + submit 会点空 —— 表现就是"点了生成没反应"。
  //   这里先确认编辑器在不在，不在就切回生成页再等它出来。
  async ensureGeneratePage(timeoutMs = 25000) {
    // ⚠️ 只看有没有 contenteditable 不够：创作首页也有输入框，但那里没有比例/模型按钮，
    //   真正能用的是 /ai-tool/generate 那一页。这里要求「在生成页 且 有输入框」。
    const 就绪 = () => this.cdp.evalJs(
      '(() => {'
      + ' const ed = !!document.querySelector(\'div.tiptap.ProseMirror,[contenteditable=true]\');'
      + ' const 生成页 = location.pathname.includes(\'/ai-tool/generate\') || !!document.querySelector(\'[aria-label="模型"]\');'
      + ' return ed && 生成页 }'
      + ')()',
      8000,
    ).catch(() => false)
    if (await 就绪()) return
    try { await this.cdp.send('Page.navigate', { url: GEN_URL }) } catch (error) {}
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(700)
      if (await 就绪()) { await sleep(600); return }
    }
    throw new Error('即梦页面切不回生成页（没有输入框或不在 /ai-tool/generate）；请在浏览器里手动打开图片生成页')
  }
  // ===== LOCAL-PATCH:生成页自检 END =====

  async waitEditor(timeoutMs = 45000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await this.cdp.evalJs(`(() => ({ ed: !!document.querySelector('div.tiptap.ProseMirror,[contenteditable=true]') }))()`, 8000).catch(() => null)
      if (state?.ed) return
      await sleep(600)
    }
    throw new Error('即梦编辑器未出现；请确认浏览器停在图片生成页且已加载完成')
  }

  async connect() {
    await this.ensureBrowser()
    this.tab = await this.openTab()
    let lastErr = null
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      try {
        this.cdp = await Cdp.connect(this.tab.webSocketDebuggerUrl)
        lastErr = null
        break
      } catch (e) {
        lastErr = e
        await sleep(2000)
      }
    }
    if (!this.cdp) throw new Error('即梦标签页没有就绪：' + (lastErr?.message || 'CDP 连接失败'))
    await this.cdp.send('Network.enable')
    await this.cdp.send('Page.bringToFront').catch(() => {})
    await sleep(800)
    return this
  }

  async readState() {
    return await this.cdp.evalJs(READ_STATE)
  }

  async modelPopupOpen() {
    return await this.cdp.evalJs(MODEL_POPUP_OPEN).catch(() => false)
  }

  /**
   * 关掉模型弹层，但不改当前选择。
   * 只用键盘/合成事件，绝不点触发按钮附近的坐标 —— 弹层可能正好盖在按钮上，
   * 点下去就成了「选中某个模型」。
   */
  async closeModelPopup() {
    for (let i = 0; i < 3; i++) {
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(320)
      if (!(await this.modelPopupOpen())) return true
    }
    await this.cdp.evalJs(ESCAPE_EVENT).catch(() => {})
    await sleep(400)
    return !(await this.modelPopupOpen())
  }

  /**
   * 打开模型下拉（已经开着就直接读）→ 读所有 li[role=option] 的首行 → 关掉弹层。
   * 用于设置页的「刷新可用模型」：读出页面当下真实在卖的模型，避免名字对不上。
   * @returns {{current: string, models: {name: string, price?: string, sub?: string}[], names: string[], closed: boolean}}
   */
  async readModels({ timeoutMs = 8000, limit = 80 } = {}) {
    if (!this.cdp) throw new Error('还没连上即梦页面')
    const before = await this.readState().catch(() => null)

    // 选项里的价格、副标题是异步刷新的，连读两次一样、而且至少有一行有名字，才算稳定。
    const waitOptions = async (deadline) => {
      let rows = []
      let liveCurrent = ''
      let lastKey = ''
      let stable = 0
      while (Date.now() < deadline) {
        const snap = await this.cdp.evalJs(READ_MODEL_OPTIONS).catch(() => null)
        if (snap && Array.isArray(snap.rows)) {
          rows = snap.rows
          if (snap.current) liveCurrent = String(snap.current).trim()
          const named = rows.some((r) => String(r?.name || '').trim())
          const key = rows.map((r) => `${r.name}|${r.price}|${r.sub}`).join('\n')
          stable = named && key === lastKey ? stable + 1 : 1
          lastKey = key
          if (named && stable >= 2) break
        }
        await sleep(350)
      }
      return { rows, liveCurrent }
    }

    let opened = false
    const openPopup = async () => {
      const deadlineAll = Date.now() + Math.max(6000, timeoutMs)
      for (let attempt = 0; attempt < 3 && Date.now() < deadlineAll; attempt++) {
        // 刚拉起的窗口会先渲染骨架再落位，等触发器的位置别跳了再点。
        let last = ''
        for (let i = 0; i < 8; i++) {
          const rect = await this.cdp.evalJs(OPEN_MODEL).catch(() => null)
          if (rect) {
            const key = `${rect.x},${rect.y}`
            if (key === last) break
            last = key
          }
          await sleep(300)
        }
        opened = true
        // 先试 DOM click：不受加载中遮罩、布局抖动影响。
        await this.cdp.evalJs(CLICK_MODEL).catch(() => null)
        for (let i = 0; i < 5; i++) {
          await sleep(300)
          if (await this.modelPopupOpen()) return
        }
        // 有的组件只认真实指针事件，再补一次 CDP 鼠标点击（坐标现取）。
        const btn = await this.cdp.evalJs(OPEN_MODEL).catch(() => null)
        if (!btn) throw new Error('找不到即梦模型选择器（页面没加载完，或还没登录）')
        await this.cdp.mouseClick(btn.x, btn.y)
        for (let i = 0; i < 8; i++) {
          await sleep(300)
          if (await this.modelPopupOpen()) return
        }
      }
      throw new Error('模型下拉没有弹开（页面可能还在生成，或没登录）')
    }

    try {
      if (!(await this.modelPopupOpen())) await openPopup()

      let got = await waitOptions(Date.now() + Math.max(3000, timeoutMs))
      const named = (list) => list.some((r) => String(r?.name || '').trim())
      // 刚打开的页面/刚唤醒的窗口，弹层可能先空着：收起来、等一下、再点一次。
      if (!named(got.rows) && opened) {
        await this.closeModelPopup().catch(() => {})
        await sleep(800)
        await openPopup()
        got = await waitOptions(Date.now() + Math.max(4000, timeoutMs))
      }

      const seen = new Set()
      const models = []
      for (const row of got.rows) {
        const name = String(row?.name || '').trim()
        // 过长的「行」多半是说明文字或广告，不当模型名。
        if (!name || name.length > 40 || seen.has(name)) continue
        seen.add(name)
        const item = { name }
        if (row?.price) item.price = String(row.price).trim()
        if (row?.sub) item.sub = String(row.sub).trim().slice(0, 40)
        models.push(item)
        if (models.length >= limit) break
      }

      let closed = true
      if (opened) closed = await this.closeModelPopup().catch(() => false)
      if (!models.length) throw new Error('模型弹层开了，但没读到任何选项（页面可能还在加载，稍后再试一次）')
      return {
        current: got.liveCurrent || String(before?.model || '').trim(),
        models,
        names: models.map((m) => m.name),
        closed,
      }
    } catch (e) {
      // 读失败也要把弹层收掉，不能把用户的页面留在下拉打开的状态。
      if (opened) await this.closeModelPopup().catch(() => {})
      throw e
    }
  }

  async closeLogin() {
    const open = await this.cdp.evalJs(LOGIN_OPEN).catch(() => ({ open: false }))
    if (!open?.open) return
    await this.cdp.evalJs(CLOSE_LOGIN)
    await sleep(500)
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
  }

  async setModel(name) {
    const wanted = String(name || '').trim()
    if (!wanted) return
    const before = await this.readState()
    if (before.model === wanted) return

    const btn = await this.cdp.evalJs(OPEN_MODEL)
    if (!btn) throw new Error('找不到即梦模型选择器')
    if (!btn.open) {
      await this.cdp.mouseClick(btn.x, btn.y)
      await sleep(700)
    }

    const pos = await this.cdp.evalJs(OPTION_POS(wanted))
    if (!pos?.ok) {
      const names = Array.isArray(pos?.names) ? pos.names : []
      throw new Error(`没有模型「${wanted}」；页面现有：${names.join('、') || '未读到'}`)
    }
    await this.cdp.mouseClick(pos.x, pos.y)

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      await sleep(350)
      const st = await this.readState()
      if (st.model === wanted) return
    }
    throw new Error(`模型切换失败：页面仍显示 ${(await this.readState()).model || '空'}`)
  }

  async formatOpen() {
    return await this.cdp.evalJs(`(() => {
      const __vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
      return Boolean([...document.querySelectorAll('[role="tooltip"]')].find(__vis))
    })()`)
  }

  async openFormat() {
    if (await this.formatOpen()) return
    const btn = await this.cdp.evalJs(FORMAT_POS)
    if (!btn) throw new Error('找不到比例/清晰度按钮')
    await this.cdp.mouseClick(btn.x, btn.y)
    await sleep(700)
    if (!(await this.formatOpen())) {
      await this.cdp.mouseClick(btn.x, btn.y)
      await sleep(700)
    }
    if (!(await this.formatOpen())) throw new Error('比例/清晰度面板没打开')
  }

  async chooseInFormat(text) {
    const pos = await this.cdp.evalJs(TOOLTIP_POS(String(text)))
    if (!pos?.ok) {
      const known = new Set([...RATIOS, ...RESOLUTIONS])
      const options = String(pos?.options || '')
        .split('\n').map((s) => s.trim()).filter((s) => known.has(s)).join('、')
      throw new Error(`比例/清晰度选项不存在：${text}（${pos?.why || 'unknown'}${options ? `；页面可选：${options}` : ''}）`)
    }
    await this.cdp.mouseClick(pos.x, pos.y)
    await sleep(500)
    return true
  }

  async setFormat({ ratio, resolution }) {
    if (!ratio && !resolution) return
    const state = await this.readState().catch(() => null)
    if (formatMatches(state?.format, ratio, resolution)) return
    if (await this.modelPopupOpen().catch(() => false)) {
      await this.closeModelPopup().catch(() => {})
    }
    await this.openFormat()
    if (ratio) {
      await this.chooseInFormat(ratio)
      await sleep(300)
    }
    if (resolution) {
      // 选完比例后有时会留一个旧 tooltip/自动收起，直接关掉重开最稳。
      if (ratio) {
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
        await sleep(250)
      }
      await this.openFormat()
      await this.chooseInFormat(resolution)
    }
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)
  }

  async setCount(n) {
    const count = Number(n)
    if (!Number.isInteger(count) || count < 1) return

    const btn = await this.cdp.evalJs(`(() => {
      ${PAGE_HELPERS}
      const el = [...document.querySelectorAll('[aria-label^="选择生成数量"]')].find(__vis)
      if (!el) return null
      if ((el.innerText || '').trim().startsWith(${JSON.stringify(String(count))})) return { current: true }
      const r = el.getBoundingClientRect()
      return { current: false, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!btn) throw new Error('找不到生成数量按钮')
    if (btn.current) return

    await this.cdp.mouseClick(btn.x, btn.y)
    await sleep(600)
    const pos = await this.cdp.evalJs(`(() => {
      ${PAGE_HELPERS}
      const pop = [...document.querySelectorAll('div')].filter(__vis)
        .find((d) => {
          const r = d.getBoundingClientRect()
          return r.height < 320 && /生成数量/.test(d.innerText || '')
        })
      const scope = pop || document
      const hit = [...scope.querySelectorAll('div,span,li,button')].filter(__vis)
        .find((el) => __clean(el.innerText) === ${JSON.stringify(String(count))})
      if (!hit) return { ok: false }
      const r = hit.getBoundingClientRect()
      return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    if (!pos?.ok) throw new Error(`没有生成数量选项：${count}`)
    await this.cdp.mouseClick(pos.x, pos.y)
    await sleep(500)
  }

  async setPrompt(prompt) {
    const text = String(prompt || '').trim()
    if (!text) throw new Error('缺少提示词')
    const typed = await this.cdp.evalJs(SET_PROMPT(text))
    if (!typed?.ok) throw new Error('输入提示词失败：' + (typed?.why || 'unknown'))
    if (!typed.submit || typed.disabled) throw new Error('生成按钮不可用（可能需要先登录或等待页面加载）')
  }

  async submit() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pos = await this.cdp.evalJs(SUBMIT_POS)
      if (!pos) throw new Error('找不到生成按钮')
      if (pos.disabled) throw new Error('生成按钮不可用（可能是登录、额度或参数问题）')
      await this.cdp.mouseClick(pos.x, pos.y)
      await sleep(900)
      const login = await this.cdp.evalJs(LOGIN_OPEN).catch(() => ({ open: false }))
      if (!login?.open) return
      await this.closeLogin()
    }
    throw new Error('多次提交仍被登录墙拦截，需要先在 Edge 里登录即梦')
  }

  /**
   * 点完生成后先确认「真的开始跑了」。
   * 即梦偶尔点了没反应（按钮没点中、额度耗尽、提示词被拦），这时候干等 5 分钟毫无意义。
   */
  async confirmStarted(preIds, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
      const deadline = Date.now() + 9000
      while (Date.now() < deadline) {
        await sleep(800)
        const st = await this.cdp.evalJs(POLL_IDS(preIds), 10000).catch(() => null)
        if (!st) continue
        if (st.failed) throw new Error('即梦拒绝了这次生成（可能积分不足、内容不合规或参数不支持）')
        if (st.n > 0 || st.generating) return true
        const login = await this.cdp.evalJs(LOGIN_OPEN).catch(() => ({ open: false }))
        if (login?.open) throw new Error('即梦弹出了登录窗口：先在 Edge 里扫码登录一次，再调用 jimeng_paint')
      }
      if (i < attempts - 1) await this.submit()
    }
    throw new Error('点了生成但即梦没有任何反应（没出图，也没显示「生成中」）：可能是额度不足、提示词被拦或按钮没点中')
  }

  async waitResults(preIds, count) {
    const want = Math.max(1, Number(count) || 1)
    const started = Date.now()
    const deadline = started + this.timeoutMs
    let result = null
    let stable = 0
    let sawProgress = false
    while (Date.now() < deadline) {
      await sleep(700)
      const st = await this.cdp.evalJs(POLL_IDS(preIds), 10000).catch(() => null)
      if (!st) {
        if (Date.now() - started > this.stallTimeoutMs) {
          throw new Error(`提交后 ${Math.round((Date.now() - started) / 1000)} 秒读不到即梦页面（标签页可能被关掉或卡死了）`)
        }
        continue
      }
      if (st.failed) throw new Error('即梦拒绝了这次生成（可能积分不足、内容不合规或参数不支持）')
      if (st.generating || st.n > 0) sawProgress = true
      if (st.n > 0) {
        result = st
        // 不再依赖「生成完成」文案：新图 id 稳定出现两轮就下载。
        if (st.done && st.n >= want) break
        if (st.n >= want) {
          stable += 1
          if (stable >= 2) break
        } else {
          stable = 0
        }
      } else if (!sawProgress && Date.now() - started > this.stallTimeoutMs) {
        // 点了生成却连「生成中」都没出现：别再空等满 5 分钟。
        throw new Error(
          `提交后 ${Math.round((Date.now() - started) / 1000)} 秒即梦没有任何反应（没出图，也没显示「生成中」）：` +
          '可能是额度不足、提示词被拦、按钮没点中，或者页面卡住了。'
        )
      }
    }
    if (!result?.n) throw new Error(`等待即梦生成超时（${Math.round(this.timeoutMs / 1000)} 秒内没有拿到图）`)
    return result
  }

  async download(ids, outDir) {
    fs.mkdirSync(outDir, { recursive: true })
    const urls = await this.cdp.evalJs(ORIGINAL_URLS(ids))
    const files = []
    for (const [id, url] of Object.entries(urls)) {
      const r = await fetch(url, { headers: { referer: 'https://jimeng.jianying.com/' } })
      if (!r.ok) continue
      const buf = Buffer.from(await r.arrayBuffer())
      const isPng = buf.slice(1, 4).toString() === 'PNG'
      const file = path.join(outDir, `jimeng-${Date.now()}-${String(id).slice(0, 8)}.${isPng ? 'png' : 'jpg'}`)
      fs.writeFileSync(file, buf)
      files.push(file)
    }
    return { files, urls: Object.values(urls) }
  }

  async generate({ prompt, model, ratio, resolution, count = 1, outDir, dryRun = false }) {
    const started = Date.now()
    await this.connect()

    await this.ensureGeneratePage()
    await this.waitEditor().catch(async (e) => {
      const login = await this.cdp.evalJs(LOGIN_OPEN).catch(() => ({ open: false }))
      if (login?.open) throw new Error('即梦还没有登录：请在弹出的 Edge 窗口里扫码登录一次，然后再调用 jimeng_paint')
      throw e
    })
    await this.closeLogin()
    await this.setModel(model)
    const wantModel = String(model || '').trim()
    if (wantModel) {
      const actual = await this.readState()
      if (actual.model !== wantModel) {
        throw new Error(`模型没有切到「${wantModel}」，当前页面是「${actual.model || '空'}」；已停止生成，不会替你换模型。`)
      }
    }
    await this.setFormat({ ratio, resolution })
    await this.setCount(count)
    await this.setPrompt(prompt)

    if (dryRun) {
      const state = await this.readState()
      this.close()
      return { ok: true, dryRun: true, state, seconds: (Date.now() - started) / 1000 }
    }

    const preIds = await this.cdp.evalJs(ALL_IDS)
    await this.submit()
    await this.confirmStarted(preIds)
    const result = await this.waitResults(preIds, count)
    let { files, urls } = await this.download(result.ids, outDir)
    if (!files.length) {
      // 图片 id 先出现、原图签名稍后才可用，给一次很短的补齐机会。
      await sleep(1200)
      ;({ files, urls } = await this.download(result.ids, outDir))
    }
    const state = await this.readState().catch(() => null)
    this.close()
    return {
      ok: files.length > 0,
      files,
      urls,
      ids: result.ids,
      model: state?.model || model,
      format: state?.format || '',
      count: result.n,
      seconds: (Date.now() - started) / 1000,
    }
  }

  close() {
    try { this.cdp?.close() } catch { /* ignore */ }
    this.cdp = null
  }
}

// 页面就绪了没：模型选择器在不在、是不是停在登录页。
const PAGE_READY = `(() => {
  ${PAGE_HELPERS}
  const btn = [...document.querySelectorAll('[aria-label="模型"]')].find(__vis)
  const body = ((document.body && document.body.innerText) || '').slice(0, 600)
  const login = /扫码登录|手机号登录|登录后即可|请先登录|欢迎登录即梦/.test(body)
  return { selector: !!btn, login }
})()`

/**
 * 独立读一次页面上的实时模型列表（设置页「刷新」用）。
 * launch=true 时（用户点了刷新）会自己拉起装好 CDP 的 Edge、打开即梦页再读；
 * launch=false（页面初次加载）只碰已经开着的 CDP，不弹窗。
 * 任何情况都不提交生成。
 * @returns {Promise<{ok: boolean, live: boolean, launched: boolean, reason: string, error: string,
 *   current: string, models: {name: string, price?: string}[], names: string[]}>}
 */
export async function listModels({ port, profileDir, edgeExe, timeoutMs = 15000, launch = false } = {}) {
  const p = Number(port) > 0 ? Number(port) : DEFAULT_CDP_PORT
  const bridge = new JimengBridge({ port: p, profileDir, edgeExe })
  let launched = false
  const fallback = (reason, error) => ({
    ok: false,
    live: false,
    launched,
    reason,
    error,
    current: '',
    models: MODEL_NAMES.map((name) => ({ name })),
    names: MODEL_NAMES.slice(),
  })

  let alive = await bridge.cdpAlive()

  if (!alive) {
    if (!launch) {
      return fallback('cdp-offline', `Edge 调试端口 ${p} 没开；点「刷新列表」会自动打开即梦（第一次约 10–30 秒）`)
    }
    try {
      await bridge.ensureBrowser()
      alive = true
      launched = true
    } catch (e) {
      return fallback('launch-failed', `自动打开 Edge 失败：${String(e?.message || e).slice(0, 200)}`)
    }
  }

  let tab = null
  try {
    const targets = await listTargets(p)
    tab = targets.find((t) => t.type === 'page' && (t.url || '').includes('jimeng.jianying.com')) || null
  } catch (e) {
    return fallback('cdp-error', '读不到 Edge 标签页：' + (e?.message || e))
  }

  if (!tab) {
    if (!launch) {
      return fallback('no-page', 'Edge 在，但没有打开即梦生成页；点「刷新列表」会自动打开')
    }
    try {
      await bridge.openTab()
      launched = true
      const deadline = Date.now() + 10000
      while (!tab && Date.now() < deadline) {
        await sleep(500)
        const targets = await listTargets(p).catch(() => [])
        tab = targets.find((t) => t.type === 'page' && (t.url || '').includes('jimeng.jianying.com')) || null
      }
    } catch (e) {
      return fallback('no-page', '打不开即梦页面：' + String(e?.message || e).slice(0, 200))
    }
    if (!tab) {
      return fallback('no-page', '即梦页面没打开成功；在自动弹出的 Edge 里手动打开 jimeng.jianying.com 再刷新')
    }
  }

  let cdp = null
  try {
    cdp = await Cdp.connect(tab.webSocketDebuggerUrl)
    bridge.cdp = cdp
    await cdp.send('Page.bringToFront').catch(() => {})

    // 首屏可能还在加载；刚拉起的窗口还要走一遍登录态判断，先等选择器出现。
    const waitMs = launch ? 20000 : 8000
    const deadline = Date.now() + waitMs
    let ready = null
    while (Date.now() < deadline) {
      ready = await cdp.evalJs(PAGE_READY).catch(() => null)
      if (ready && ready.selector) break
      await sleep(600)
    }
    if (!ready || !ready.selector) {
      if (ready && ready.login) {
        return fallback('login-required', 'Edge 已打开即梦，但还没登录：在刚弹出的窗口里扫码登录一次，再点「刷新列表」')
      }
      return fallback('not-ready', '即梦页面还没加载完（没找到模型选择器）；等页面出来再点刷新')
    }

    const live = await bridge.readModels({ timeoutMs })
    return { ok: true, live: true, launched, reason: '', error: '', ...live }
  } catch (e) {
    return fallback('read-failed', String(e?.message || e).slice(0, 300))
  } finally {
    try { cdp?.close() } catch { /* ignore */ }
    bridge.cdp = null
  }
}

export async function status({ port, profileDir, edgeExe } = {}) {
  const p = Number(port) > 0 ? Number(port) : DEFAULT_CDP_PORT
  const bridge = new JimengBridge({ port: p, profileDir, edgeExe })
  const alive = await bridge.cdpAlive()
  if (!alive) {
    return {
      cdpAlive: false,
      port: p,
      profileDir: bridge.profileDir,
      pageFound: false,
      editorReady: false,
      login: true,
      model: '',
      models: MODEL_NAMES,
      modelsLive: false,
      modelsError: '',
      hint: 'Edge 调试端口没开；第一次调用 jimeng_paint 会自动拉起 Edge。',
    }
  }
  let pageFound = false
  let editorReady = false
  let model = ''
  let login = true
  let models = MODEL_NAMES
  let modelsLive = false
  let modelsError = ''
  try {
    const targets = await listTargets(p)
    const tab = targets.find((t) => (t.url || '').includes('jimeng.jianying.com'))
    pageFound = Boolean(tab)
    if (tab) {
      const cdp = await Cdp.connect(tab.webSocketDebuggerUrl)
      await cdp.send('Page.bringToFront').catch(() => {})
      const st = await cdp.evalJs(READ_STATE).catch(() => null)
      editorReady = Boolean(await cdp.evalJs(`!!document.querySelector('div.tiptap.ProseMirror,[contenteditable=true]')`).catch(() => false))
      model = st?.model || ''
      login = st?.login ?? true
      // 尽量给实时模型；读不到就退回静态清单，只报一句错，不抛。
      if (editorReady && !st?.generating) {
        bridge.cdp = cdp
        try {
          const live = await bridge.readModels({ timeoutMs: 6000 })
          models = live.names
          modelsLive = true
          if (!model) model = live.current
        } catch (e) {
          modelsError = String(e?.message || e).slice(0, 200)
        } finally {
          bridge.cdp = null
        }
      }
      cdp.close()
    }
  } catch { /* ignore */ }
  return {
    cdpAlive: true,
    port: p,
    profileDir: bridge.profileDir,
    pageFound,
    editorReady,
    model,
    models,
    modelsLive,
    modelsError,
    login,
    hint: pageFound && editorReady
      ? '即梦页面在线，可以出图'
      : 'CDP 在线但没有就绪的即梦生成页；调用 jimeng_paint 时会自动打开。',
  }
}
