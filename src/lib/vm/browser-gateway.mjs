/** Authenticated Selkies HTTP and WebSocket reverse proxy. */
import http from 'node:http'
import { getVm } from './vm-registry.mjs'
import { browserProxyTarget } from './browser-runtime.mjs'
import { authorizePanelRoute, panelIdentity } from '../admin/panel-acl.mjs'
import { denyIfUserMissesVm } from '../admin/panel-tenant.mjs'

const VIEW = /^\/api\/panel\/vms\/([A-Za-z0-9_-]+)\/browser\/view\//
const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function browserViewId(url) {
  return VIEW.exec(new URL(url || '/', 'http://local').pathname)?.[1] || null
}

export function sameBrowserOrigin(req) {
  if (!req.headers.origin) return true
  try {
    return new URL(req.headers.origin).host === req.headers.host
  } catch {
    return false
  }
}

function upstreamHeaders(req, target, upgrade = false) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP.has(key) || ['cookie', 'authorization', 'host', 'origin'].includes(key) || key.startsWith('x-forwarded-'))
      continue
    headers[key] = value
  }
  headers.host = `${target.hostname}:${target.port}`
  headers.authorization = target.authorization
  if (upgrade) {
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'
  }
  return headers
}

export function createBrowserGateway({
  projectRoot,
  requireAuth,
  json,
  targetFor = browserProxyTarget,
  findVm = getVm,
}) {
  function authorize(req, res, pathname) {
    if (!sameBrowserOrigin(req)) {
      json(res, 403, { ok: false, error: { message: 'Browser origin denied' } })
      return false
    }
    if (!requireAuth(req, res)) return false
    if (!req.panelUser && req.apiKeyKind !== 'master') {
      json(res, 403, { ok: false, error: { message: 'Panel login required' } })
      return false
    }
    if (!authorizePanelRoute(req.method, pathname, panelIdentity(req).role).ok) {
      json(res, 403, { ok: false, error: { message: 'Browser access denied' } })
      return false
    }
    return !denyIfUserMissesVm(req, res, { projectRoot, json, path: pathname })
  }

  async function target(req) {
    const id = browserViewId(req.url)
    const vm = findVm(projectRoot, id)
    if (!vm || vm.node_id) return null
    return targetFor(vm, projectRoot)
  }

  // Called by panel-routes after its existing auth + tenant gates.
  async function handleHttp(req, res) {
    if (!browserViewId(req.url)) return false
    if (!sameBrowserOrigin(req)) {
      json(res, 403, { ok: false, error: { message: 'Browser origin denied' } })
      return true
    }
    const upstream = await target(req)
    if (!upstream) {
      json(res, 409, {
        ok: false,
        error: { code: 'browser_not_ready', message: '浏览器未启动或 VM 出口已变更，请从 VM 页面重新打开' },
      })
      return true
    }
    const proxy = http.request(
      {
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req, upstream),
      },
      (reply) => {
        const headers = {}
        for (const [key, value] of Object.entries(reply.headers)) {
          if (!HOP.has(key) && key !== 'set-cookie' && key !== 'www-authenticate') headers[key] = value
        }
        // Never cache a logged-in browser desktop in an intermediary.
        headers['cache-control'] = 'no-store'
        headers['referrer-policy'] = 'same-origin'
        res.writeHead(reply.statusCode, headers)
        reply.pipe(res)
        reply.on('error', () => res.destroy())
      },
    )
    proxy.setTimeout(30_000, () => proxy.destroy())
    proxy.on('error', () => {
      if (res.headersSent) res.destroy()
      else json(res, 502, { ok: false, error: { message: '浏览器仍在启动，请稍后刷新' } })
    })
    req.on('aborted', () => proxy.destroy())
    res.on('close', () => proxy.destroy())
    req.pipe(proxy)
    return true
  }

  function handleUpgrade(req, socket, head) {
    if (!browserViewId(req.url)) return false
    const res = new http.ServerResponse(req)
    res.shouldKeepAlive = false
    res.on('finish', () => socket.end())
    res.assignSocket(socket)
    const pathname = new URL(req.url, 'http://local').pathname
    if (!authorize(req, res, pathname)) return true
    res.detachSocket(socket)
    void (async () => {
      const upstream = await target(req)
      if (!upstream) {
        socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n')
        return
      }
      const proxy = http.request({
        hostname: upstream.hostname,
        port: upstream.port,
        path: req.url,
        headers: upstreamHeaders(req, upstream, true),
      })
      let peer
      proxy.setTimeout(15_000, () => proxy.destroy())
      proxy.on('upgrade', (reply, upstreamSocket, upstreamHead) => {
        peer = upstreamSocket
        proxy.setTimeout(0)
        let status = 'HTTP/1.1 101 Switching Protocols\r\n'
        for (const [key, value] of Object.entries(reply.headers)) {
          if (key !== 'set-cookie') status += `${key}: ${value}\r\n`
        }
        socket.write(`${status}\r\n`)
        if (upstreamHead.length) socket.write(upstreamHead)
        if (head.length) upstreamSocket.write(head)
        socket.pipe(upstreamSocket).pipe(socket)
        upstreamSocket.on('error', () => socket.destroy())
        upstreamSocket.on('close', () => socket.destroy())
      })
      proxy.on('response', () => socket.destroy())
      proxy.on('error', () => socket.destroy())
      socket.on('error', () => {
        proxy.destroy()
        peer?.destroy()
      })
      socket.on('close', () => {
        proxy.destroy()
        peer?.destroy()
      })
      proxy.end()
    })().catch(() => socket.destroy())
    return true
  }

  return { handleHttp, handleUpgrade }
}
