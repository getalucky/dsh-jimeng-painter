/**
 * 极简 CDP 客户端：只够驱动 Edge 里的即梦网页。
 * Node 22+ 自带 WebSocket 与 fetch。
 */
import fs from 'node:fs'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`/json/list ${r.status}`)
  return await r.json()
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString()) } catch { return }
      if (!msg?.id || !this.pending.has(msg.id)) return
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else p.resolve(msg.result)
    })
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'))
      this.pending.clear()
    })
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 8000)
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
    })
    const client = new Cdp(ws)
    try {
      await client.send('Page.enable')
      await client.send('Runtime.enable')
    } catch (e) {
      client.close()
      throw e
    }
    return client
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async evalJs(expression, timeoutMs = 30000) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs)
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result?.value
  }

  async screenshot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
    return file
  }

  async mouseClick(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  close() {
    try { this.ws.close() } catch { /* ignore */ }
  }
}

export function edgePath() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
  ]
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate
  throw new Error('找不到 Edge（请确认已安装 Microsoft Edge）')
}

export const VIS_HELPER = `
const __vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1 }
const __clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
`
