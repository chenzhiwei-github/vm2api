import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { createBrowserGateway } from '../../src/lib/vm/browser-gateway.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const view = '/api/panel/vms/vm-one/browser/view/'

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-gateway-'))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(path.join(root, 'vms/vm-one.json'), JSON.stringify({ id: 'vm-one', owner_user_id: 'owner-one' }))
  let received
  const upstream = http.createServer((req, res) => {
    received = req.headers
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'do-not-forward=secret' })
    res.end(req.url)
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (ws, req) => {
    received = req.headers
    ws.on('message', (data) => ws.send(data))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const gateway = createBrowserGateway({
    projectRoot: root,
    json,
    requireAuth(req, res) {
      const token = req.headers.authorization
      if (!token) {
        json(res, 401, { error: 'login required' })
        return false
      }
      req.panelUser = 'user'
      req.panelRole = 'user'
      req.panelUserId = token === 'Bearer owner' ? 'owner-one' : 'someone-else'
      return true
    },
    targetFor: async () => ({
      hostname: '127.0.0.1',
      port: upstream.address().port,
      authorization: 'Basic private-browser-credential',
    }),
  })
  const server = http.createServer((req, res) => {
    void gateway.handleHttp(req, res)
  })
  server.on('upgrade', gateway.handleUpgrade)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    server.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))])
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    get received() {
      return received
    },
  }
}

test('HTTP proxy preserves subfolder but strips panel credentials and upstream cookies', async (t) => {
  const f = await fixture(t)
  const response = await fetch(`${f.base}${view}assets/app.js`, {
    headers: { Authorization: 'Bearer panel-secret', Cookie: 'kin_panel_token=panel-secret' },
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), `${view}assets/app.js`)
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(f.received.authorization, 'Basic private-browser-credential')
  assert.equal(f.received.cookie, undefined)
})

test('WebSocket relay authenticates and sends bytes through the VM-specific backend', async (t) => {
  const f = await fixture(t)
  const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}${view}websockify`, {
    headers: { Authorization: 'Bearer owner', Cookie: 'kin_panel_token=secret' },
  })
  await once(ws, 'open')
  const echoed = once(ws, 'message')
  ws.send('browser-stream')
  assert.equal(String((await echoed)[0]), 'browser-stream')
  assert.equal(f.received.cookie, undefined)
  assert.equal(f.received.authorization, 'Basic private-browser-credential')
  ws.close()
  await once(ws, 'close')
})

for (const [name, headers, code] of [
  ['anonymous', {}, 401],
  ['another VM owner', { Authorization: 'Bearer stranger' }, 404],
  ['cross-site origin', { Authorization: 'Bearer owner', Origin: 'https://evil.example' }, 403],
]) {
  test(`WebSocket rejects ${name}`, async (t) => {
    const f = await fixture(t)
    const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}${view}websockify`, { headers })
    const response = await new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode)
        res.resume()
        ws.terminate()
      })
      ws.on('error', () => {})
      ws.on('open', () => {
        ws.terminate()
        reject(new Error('unauthorized stream opened'))
      })
    })
    assert.equal(response, code)
  })
}

test('browser management follows credential ACL; super has no browser access', () => {
  for (const [method, endpoint] of [
    ['GET', 'browser'],
    ['POST', 'browser/start'],
    ['POST', 'browser/stop'],
    ['POST', 'browser/open'],
    ['GET', 'browser/view/websockify'],
  ]) {
    const url = `/api/panel/vms/vm-one/${endpoint}`
    assert.equal(authorizePanelRoute(method, url, 'user').ok, true)
    assert.equal(authorizePanelRoute(method, url, 'super').ok, false)
  }
})
