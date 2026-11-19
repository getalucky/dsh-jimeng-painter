/**
 * test/webapi.test.mjs —— 设置页后端接口的离线测试
 *
 * 用一个假的 webServer 收下注册的路由，再拿假 req/res 直接调 handler，
 * 不需要真的起 DSH、不碰浏览器。写盘一律写到临时目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { API_PREFIX, registerWebApi } from '../lib/webapi.js'
import { createSettings } from '../lib/settings.mjs'
import { resolveConfig } from '../lib/index.js'
import { MODEL_NAMES, RATIOS, TOOL_RESOLUTIONS } from '../lib/models.js'

const FIXTURE = [
  '- insert:',
  '    - id: dsh-jimeng-painter',
  '      name: dsh-jimeng-painter',
  '      config:',
  '        enabled: true',
  "        defaultModel: 'Seedream 5.5'",
  "        defaultRatio: '智能'",
  "        defaultResolution: '1.5K'",
  '        defaultCount: 1',
  "        defaultStyle: 'auto'",
  '        lockDefaults: false',
  '',
].join('\n')

function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const req = { method, url, headers, destroyed: false, destroy() { this.destroyed = true } }
  req.on = (event, cb) => {
    if (event === 'data' && body != null) cb(Buffer.from(body, 'utf8'))
    if (event === 'end') cb()
    return req
  }
  return req
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v },
    end(t) { this.body = t == null ? '' : String(t) },
  }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-webapi-'))
  const file = path.join(dir, 'cordis.patch.yml')
  fs.writeFileSync(file, FIXTURE, 'utf8')
  const settings = createSettings({
    rawConfig: { enabled: true, cdpPort: 9335 },
    patchPath: file,
    resolve: resolveConfig,
  })
  const routes = new Map()
  const ctx = {
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => {}
      },
    },
  }
  const api = registerWebApi(ctx, {
    settings,
    bridgeOpts: () => ({ port: 1, profileDir: '', edgeExe: '' }),
    version: 'test',
  })
  return { dir, file, settings, routes, api, ctx }
}

async function call(routes, p, opts = {}) {
  const routePath = p.split('?')[0]
  const handler = routes.get(routePath)
  assert.ok(handler, '没注册路由 ' + routePath)
  const res = fakeRes()
  await handler.handler(fakeReq({ url: p, ...opts }), res)
  return { res, body: res.body ? JSON.parse(res.body) : null }
}

test('没有 webServer / settings 时返回 null，不抛', () => {
  assert.equal(registerWebApi({}, {}), null)
  assert.equal(registerWebApi({ webServer: { register() {} } }, {}), null)
  assert.equal(registerWebApi(null, { settings: { get() {} } }), null)
})

test('注册三条 exact 路由，dispose 能重复调用', () => {
  const { routes, api } = setup()
  assert.deepEqual([...routes.keys()].sort(), [
    `${API_PREFIX}/config`,
    `${API_PREFIX}/models`,
  ].sort())
  assert.equal(routes.get(`${API_PREFIX}/config`).kind, 'exact')
  api.dispose()
  api.dispose()
})

test('GET /config 给出默认值、可选项和 patch 信息', async () => {
  const { routes } = setup()
  const { res, body } = await call(routes, `${API_PREFIX}/config`)
  assert.equal(res.statusCode, 200)
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(body.ok, true)
  assert.deepEqual(body.config, {
    defaultModel: 'Seedream 5.5',
    defaultRatio: '智能',
    defaultResolution: '1.5K',
    defaultCount: 1,
    defaultStyle: 'auto',
    lockDefaults: false,
  })
  assert.deepEqual(body.options.models, MODEL_NAMES)
  assert.deepEqual(body.options.ratios, RATIOS)
  assert.deepEqual(body.options.resolutions, TOOL_RESOLUTIONS)
  assert.deepEqual(body.options.counts, [1, 2, 3, 4])
  assert.equal(body.options.styles[0].id, 'auto')
  assert.ok(body.options.styles.some((s) => s.id === 'deepsea'))
  assert.deepEqual(body.patch.fields, ['defaultModel', 'defaultRatio', 'defaultResolution', 'defaultCount', 'defaultStyle', 'lockDefaults'])
  assert.equal(body.runtime.cdpPort, 1)
  assert.equal(body.version, 'test')
})

test('POST /config 保存并写回 patch，随后 GET 能读到', async () => {
  const { routes, file } = setup()
  const { res, body } = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      defaultModel: 'Seedream 5.0 Flash',
      defaultRatio: '16:9',
      defaultResolution: '2K',
      defaultCount: 2,
      defaultStyle: '深海',
    }),
  })
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, true)
  assert.equal(body.persisted, true)
  assert.equal(body.warning, '')
  assert.deepEqual(body.config, {
    defaultModel: 'Seedream 5.0 Flash',
    defaultRatio: '16:9',
    defaultResolution: '2K',
    defaultCount: 2,
    defaultStyle: 'deepsea',
    lockDefaults: false,
  })
  assert.equal(body.patch.file, 'cordis.patch.yml')

  const onDisk = fs.readFileSync(file, 'utf8')
  assert.match(onDisk, /defaultModel: 'Seedream 5\.0 Flash'/)
  assert.match(onDisk, /defaultCount: 2$/m)
  assert.match(onDisk, /defaultStyle: 'deepsea'$/m)

  const after = await call(routes, `${API_PREFIX}/config`)
  assert.deepEqual(after.body.config, body.config)
  assert.equal(after.body.patch.last.persisted, true)
})

test('lockDefaults 勾上后保存，再读还是 true', async () => {
  const { routes, file } = setup()
  const saved = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lockDefaults: true }),
  })
  assert.equal(saved.res.statusCode, 200)
  assert.equal(saved.body.config.lockDefaults, true)
  assert.equal(saved.body.persisted, true)
  assert.match(fs.readFileSync(file, 'utf8'), /^[ \t]*lockDefaults: true$/m)

  const after = await call(routes, `${API_PREFIX}/config`)
  assert.equal(after.body.config.lockDefaults, true)

  const off = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ lockDefaults: false }),
  })
  assert.equal(off.body.config.lockDefaults, false)
  assert.match(fs.readFileSync(file, 'utf8'), /^[ \t]*lockDefaults: false$/m)
})

test('POST /config 的护栏：415 / 405 / 400 / 403', async () => {
  const { routes } = setup()

  const wrongType = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })
  assert.equal(wrongType.res.statusCode, 415)

  const wrongMethod = await call(routes, `${API_PREFIX}/config`, { method: 'PUT' })
  assert.equal(wrongMethod.res.statusCode, 405)
  assert.equal(wrongMethod.res.headers.allow, 'GET, POST')

  const badJson = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(badJson.res.statusCode, 400)

  const badValue = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaultCount: 9 }),
  })
  assert.equal(badValue.res.statusCode, 400)
  assert.ok(Array.isArray(badValue.body.errors) && badValue.body.errors.length === 1)

  const crossSite = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ defaultCount: 2 }),
  })
  assert.equal(crossSite.res.statusCode, 403)

  const badOrigin = await call(routes, `${API_PREFIX}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: '127.0.0.1:53113' },
    body: JSON.stringify({ defaultCount: 2 }),
  })
  assert.equal(badOrigin.res.statusCode, 403)
})

test('GET /models 在 Edge 没开时退回静态清单且不抛', async () => {
  const { routes } = setup()
  const { res, body } = await call(routes, `${API_PREFIX}/models?refresh=1`)
  assert.equal(res.statusCode, 200)
  assert.equal(body.ok, false)
  assert.equal(body.live, false)
  assert.equal(body.source, 'static')
  assert.deepEqual(body.names, MODEL_NAMES)
  assert.deepEqual(body.fallbackNames, MODEL_NAMES)
  assert.ok(body.models.length >= 10)
  assert.equal(body.refresh, true)
  assert.equal(typeof body.error, 'string')
  assert.ok(body.error.length > 0)

  const wrongMethod = await call(routes, `${API_PREFIX}/models`, { method: 'POST' })
  assert.equal(wrongMethod.res.statusCode, 405)
})
