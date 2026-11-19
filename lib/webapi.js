/**
 * 插件自己的 HTTP 接口，只给设置页用（同源 fetch，不硬编码端口）。
 *
 *   GET  /dsh-jimeng-painter/api/config   读当前默认值 + 可选项
 *   POST /dsh-jimeng-painter/api/config   写默认值（白名单，写回 cordis.patch.yml）
 *   GET  /dsh-jimeng-painter/api/models   读页面实时模型；?refresh=1 跳过 60s 缓存
 *
 * webServer 是 DSH 的可选服务：拿不到就返回 null，插件其他部分照常工作。
 */
import { MODEL_NAMES, RATIOS, TOOL_RESOLUTIONS } from './models.js'
import { styleOptions } from './prompt.mjs'
import { listModels } from './bridge.mjs'
import { COUNT_MAX, COUNT_MIN, PATCHABLE } from './settings.mjs'

export const API_PREFIX = '/dsh-jimeng-painter/api'
const MODELS_TTL_MS = 60000
const BODY_LIMIT = 64 * 1024

function headerOf(req, name) {
  const v = req?.headers?.[name]
  return Array.isArray(v) ? v[0] : (v || '')
}

function json(res, body, code = 200) {
  if (!res || typeof res.setHeader !== 'function') return
  const text = JSON.stringify(body)
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(text))
  res.statusCode = code
  res.end(text)
}

/** 只收同源请求：挡掉跨站表单/网页；本机直连 curl 没这些头也放行。 */
function sameOrigin(req) {
  const site = headerOf(req, 'sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = headerOf(req, 'origin')
  if (origin) {
    try {
      if (new URL(origin).host !== headerOf(req, 'host')) return false
    } catch {
      return false
    }
  }
  return true
}

function readJsonBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function publicConfig(config) {
  return {
    defaultModel: config.defaultModel,
    defaultRatio: config.defaultRatio,
    defaultResolution: config.defaultResolution,
    defaultCount: config.defaultCount,
    defaultStyle: config.defaultStyle,
    lockDefaults: config.lockDefaults === true,
  }
}

/**
 * @param {object} ctx 插件 ctx（要 webServer 服务）
 * @param {{settings: object, bridgeOpts: () => object, log?: Function, version?: string}} opts
 * @returns {{dispose: Function}|null}
 */
export function registerWebApi(ctx, opts = {}) {
  const ws = ctx?.webServer
  if (!ws || typeof ws.register !== 'function') return null
  const settings = opts.settings
  if (!settings || typeof settings.get !== 'function') return null
  const log = typeof opts.log === 'function' ? opts.log : () => {}
  const bridgeOpts = typeof opts.bridgeOpts === 'function' ? opts.bridgeOpts : () => ({})

  const disposers = []
  let cache = null
  let inflight = null

  const route = (pathname, handler) => {
    try {
      const d = ws.register({ kind: 'exact', path: pathname, handler })
      if (typeof d === 'function') disposers.push(d)
      else if (d && typeof d.dispose === 'function') disposers.push(() => d.dispose())
      return true
    } catch (e) {
      log(`[dsh-jimeng-painter] 注册 ${pathname} 失败：${String(e?.message || e).slice(0, 160)}`)
      return false
    }
  }

  const readModels = async (refresh, launch) => {
    if (!refresh && cache && Date.now() - cache.at < MODELS_TTL_MS) {
      return { ...cache.payload, cached: true }
    }
    if (inflight) return await inflight
    inflight = (async () => {
      let result
      try {
        result = await listModels({ ...bridgeOpts(), timeoutMs: 20000, launch: Boolean(launch) })
      } catch (e) {
        result = { ok: false, live: false, reason: 'read-failed', error: String(e?.message || e) }
      }
      const at = Date.now()
      const payload = result.ok
        ? {
            ok: true,
            live: true,
            source: 'page',
            launched: Boolean(result.launched),
            models: result.models,
            names: result.names,
            current: result.current || '',
            error: '',
            reason: '',
            at: new Date(at).toISOString(),
          }
        : {
            ok: false,
            live: false,
            source: 'static',
            launched: Boolean(result.launched),
            models: (result.models && result.models.length ? result.models : MODEL_NAMES.map((name) => ({ name }))),
            names: (result.names && result.names.length ? result.names : MODEL_NAMES.slice()),
            current: '',
            error: result.error || '读不到页面上的模型列表',
            reason: result.reason || 'read-failed',
            at: new Date(at).toISOString(),
          }
      if (payload.live) cache = { at, payload }
      return payload
    })().finally(() => { inflight = null })
    return await inflight
  }

  route(`${API_PREFIX}/config`, async (req, res) => {
    if (!sameOrigin(req)) return json(res, { ok: false, error: '跨站请求被拒绝' }, 403)
    if (req.method === 'GET' || req.method === 'HEAD') {
      const config = settings.get()
      return json(res, {
        ok: true,
        config: publicConfig(config),
        defaults: {
          defaultModel: 'Seedream 5.5',
          defaultRatio: '智能',
          defaultResolution: '1.5K',
          defaultCount: 1,
          defaultStyle: 'auto',
          lockDefaults: false,
        },
        options: {
          models: MODEL_NAMES,
          ratios: RATIOS,
          resolutions: TOOL_RESOLUTIONS,
          counts: Array.from({ length: COUNT_MAX - COUNT_MIN + 1 }, (_, i) => COUNT_MIN + i),
          styles: styleOptions(),
        },
        patch: {
          file: settings.file || 'cordis.patch.yml',
          last: settings.last ? settings.last() : null,
          fields: PATCHABLE.slice(),
        },
        runtime: { cdpPort: bridgeOpts().port || 9335 },
        version: opts.version || '',
      })
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST')
      return json(res, { ok: false, error: '只支持 GET / POST' }, 405)
    }
    if (!/^application\/json\b/i.test(headerOf(req, 'content-type'))) {
      return json(res, { ok: false, error: 'POST 需要 content-type: application/json' }, 415)
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (e) {
      return json(res, { ok: false, error: String(e?.message || e) }, 400)
    }
    const result = settings.update(body)
    if (!result.ok) return json(res, { ok: false, errors: result.errors, error: (result.errors || [])[0] || '保存失败' }, 400)
    // 改了默认模型的话，缓存里的实时列表可能已经过时，但列表本身不该被清掉。
    return json(res, {
      ok: true,
      config: publicConfig(result.config),
      applied: result.applied,
      ignored: result.ignored,
      persisted: result.persisted,
      warning: result.warning,
      backup: result.backup ? String(result.backup).split(/[\\/]/).pop() : '',
      patch: { file: settings.file, last: settings.last ? settings.last() : null },
    })
  })

  route(`${API_PREFIX}/models`, async (req, res) => {
    if (!sameOrigin(req)) return json(res, { ok: false, error: '跨站请求被拒绝' }, 403)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET')
      return json(res, { ok: false, error: '只支持 GET' }, 405)
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const refresh = url.searchParams.get('refresh') === '1'
    const launch = url.searchParams.get('launch') === '1'
    const payload = await readModels(refresh, launch)
    return json(res, { ...payload, fallbackNames: MODEL_NAMES, refresh, launch })
  })

  if (!disposers.length) return null
  return {
    dispose() {
      for (const d of disposers.splice(0)) {
        try { d() } catch { /* ignore */ }
      }
    },
  }
}
