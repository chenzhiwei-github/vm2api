/** One persistent Chromium environment per local slot. Secrets never enter vm.json. */
import crypto from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { atomicWriteJson, isValidVmId } from './vm-file.mjs'
import { toHostPath } from './host-path.mjs'
import { ensureProxyEgress, hasBoundExit, slotNetworkForVm } from './egress.mjs'
import { validTimezone } from '../core/timezone.mjs'

const exec = promisify(execFile)
// Pin the manifest so a restart on another day does not silently change Chromium.
export const DEFAULT_BROWSER_IMAGE =
  'lscr.io/linuxserver/chromium@sha256:9761e4dce2375165ab85566d5a58920525d49c49469ed7a08a6d874dcdb1cedc'
const locks = new Map()

export function browserEnabled(env = process.env) {
  return env.KIN_BROWSER_ENABLED !== '0'
}

export function browserName(vmId) {
  if (!isValidVmId(vmId)) throw new Error('invalid vm id')
  // Hash also prevents Docker's case-insensitive/length constraints from aliasing IDs.
  return `kin-browser-${crypto.createHash('sha256').update(vmId).digest('hex').slice(0, 24)}`
}

export function browserBasePath(vmId) {
  if (!isValidVmId(vmId)) throw new Error('invalid vm id')
  return `/api/panel/vms/${vmId}/browser/view/`
}

export function browserDir(projectRoot, vmId) {
  browserName(vmId)
  return path.join(projectRoot, 'vms', vmId, 'browser')
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

/** Fail closed when identity is corrupt; never silently rotate an existing profile. */
export function ensureBrowserIdentity(vm, projectRoot, env = process.env) {
  const dir = browserDir(projectRoot, vm.id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'identity.json')
  let identity = readJson(file)
  if (identity) {
    if (
      identity.vm_id !== vm.id ||
      !/^[0-9a-f]{32}$/.test(identity.machine_id) ||
      !identity.environment_id ||
      !identity.password ||
      !identity.image
    ) {
      throw new Error('browser identity invalid; restore identity.json from backup')
    }
  } else {
    identity = {
      version: 1,
      vm_id: vm.id,
      environment_id: crypto.randomUUID(),
      machine_id: crypto.randomBytes(16).toString('hex'),
      password: crypto.randomBytes(32).toString('base64url'),
      image: env.KIN_BROWSER_IMAGE || DEFAULT_BROWSER_IMAGE,
      platform: env.KIN_BROWSER_PLATFORM || `linux/${os.arch() === 'arm64' ? 'arm64' : 'amd64'}`,
      created_at: new Date().toISOString(),
    }
    atomicWriteJson(file, identity, { mode: 0o600 })
  }
  fs.mkdirSync(path.join(dir, 'profile'), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(dir, 'machine-id'), `${identity.machine_id}\n`, { mode: 0o644 })
  return identity
}

function environment(vm, identity) {
  const locale = /^[a-z]{2}_[A-Z]{2}\.UTF-8$/.test(vm.locale || '') ? vm.locale : 'en_US.UTF-8'
  return {
    network: slotNetworkForVm(vm) || 'none',
    timezone: validTimezone(vm.timezone) || 'UTC',
    locale,
    language: locale.slice(0, 5).replace('_', '-'),
    hostname: `browser-${identity.machine_id.slice(0, 16)}`,
  }
}

export function browserConfigHash(vm, identity) {
  // Credentials/endpoint may change without changing the proxy ID.
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        environment: environment(vm, identity),
        proxy: vm.proxy || null,
        image: identity.image,
        platform: identity.platform,
        environment_id: identity.environment_id,
      }),
    )
    .digest('hex')
}

export function buildBrowserCreateArgs(vm, projectRoot, identity, hostOf = (p) => toHostPath(p, { projectRoot })) {
  const dir = browserDir(projectRoot, vm.id)
  const e = environment(vm, identity)
  const env = {
    PUID: '1000',
    PGID: '1000',
    TZ: e.timezone,
    LC_ALL: e.locale,
    CUSTOM_USER: 'chromium',
    PASSWORD: identity.password,
    SUBFOLDER: browserBasePath(vm.id),
    TITLE: `${vm.id} · Chromium`,
    KIN_BROWSER_ID: identity.environment_id,
    CHROME_CLI: `--user-data-dir=/config/chromium --lang=${e.language} --no-first-run --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp`,
    SELKIES_MODE: 'websockets',
    SELKIES_ENABLE_DUAL_MODE: 'false',
    SELKIES_MANUAL_RESOLUTION: 'true|locked',
    SELKIES_MANUAL_WIDTH: '1440',
    SELKIES_MANUAL_HEIGHT: '900',
    SELKIES_ENABLE_RESIZE: 'false|locked',
    SELKIES_SECOND_SCREEN: 'false',
    SELKIES_AUDIO_ENABLED: 'false',
    NO_GAMEPAD: 'true',
    NO_WEBCAM: 'true',
  }
  return [
    'create',
    '--name',
    browserName(vm.id),
    '--platform',
    identity.platform,
    '--hostname',
    e.hostname,
    '--network',
    e.network,
    '--restart',
    'unless-stopped',
    '--shm-size',
    '1g',
    '--memory',
    '1536m',
    '--cpus',
    '2',
    '--label',
    'kin.browser=1',
    '--label',
    `kin.browser.vm_id=${vm.id}`,
    '--label',
    `kin.browser.config=${browserConfigHash(vm, identity)}`,
    '--publish',
    '127.0.0.1::3000',
    '--mount',
    `type=bind,src=${hostOf(path.join(dir, 'profile'))},dst=/config`,
    '--mount',
    `type=bind,src=${hostOf(path.join(dir, 'machine-id'))},dst=/etc/machine-id,readonly`,
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    identity.image,
  ]
}

async function docker(args, opts = {}) {
  try {
    const { stdout } = await exec('docker', args, {
      encoding: 'utf8',
      timeout: opts.timeout || 90_000,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, stdout: stdout.trim() }
  } catch (e) {
    // Do not include execFile's message: it contains argv, including PASSWORD.
    return {
      ok: false,
      error: String(e.stderr || 'Docker browser operation failed')
        .trim()
        .slice(0, 1000),
    }
  }
}

async function inspect(vm, run) {
  const r = await run(['inspect', browserName(vm.id)])
  if (!r.ok) {
    if (/no such (object|container)/i.test(r.error || '')) return null
    throw new Error(r.error || 'browser inspect failed')
  }
  const data = JSON.parse(r.stdout)
  const doc = data[0]
  if (doc?.Config?.Labels?.['kin.browser.vm_id'] !== vm.id) throw new Error('browser container ownership mismatch')
  return doc
}

function serialize(vm, projectRoot, fn) {
  const key = browserDir(projectRoot, vm.id)
  const next = (locks.get(key) || Promise.resolve()).then(fn, fn)
  const settled = next.catch(() => {})
  locks.set(key, settled)
  settled.finally(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return next
}

function failure(code, error) {
  return { ok: false, code, error }
}

function currentVm(vm, projectRoot) {
  // API mutations may race a slow image pull. Never start a deleted slot/old binding.
  return readJson(path.join(projectRoot, 'vms', `${vm.id}.json`))
}

function publicState(vm, identity, doc) {
  return {
    ok: true,
    vm_id: vm.id,
    environment_id: identity.environment_id,
    container: browserName(vm.id),
    status: doc?.State?.Running ? 'running' : doc ? 'stopped' : 'uncreated',
    image: identity.image,
    timezone: environment(vm, identity).timezone,
    locale: environment(vm, identity).locale,
    proxy_id: vm.proxy?.id || null,
    view_path: browserBasePath(vm.id),
    fingerprint_mode: 'isolated-chromium',
  }
}

export async function ensureVmBrowser(
  vm,
  projectRoot,
  { start = false, run = docker, ensureEgress = ensureProxyEgress, hostOf } = {},
) {
  if (!browserEnabled()) return { ok: true, skipped: true, status: 'disabled' }
  if (vm.node_id) return failure('browser_remote_unsupported', '远端节点暂不支持配套浏览器')
  return serialize(vm, projectRoot, async () => {
    try {
      vm = currentVm(vm, projectRoot)
      if (!vm) return failure('vm_not_found', 'VM 已删除')
      const identity = ensureBrowserIdentity(vm, projectRoot)
      if (start && !hasBoundExit(vm.proxy)) return failure('proxy_required', '请先为 VM 绑定网络出口')
      if (start) {
        const eg = await ensureEgress(projectRoot, vm.proxy)
        if (!eg.ok) return failure('browser_egress_failed', eg.error || '浏览器出口未就绪')
      }
      const expected = browserConfigHash(vm, identity)
      let doc = await inspect(vm, run)
      if (doc && doc.Config.Labels['kin.browser.config'] !== expected) {
        const removed = await run(['rm', '-f', browserName(vm.id)])
        if (!removed.ok) return failure('browser_recreate_failed', removed.error)
        doc = null
      }
      if (!doc) {
        const image = await run(['image', 'inspect', identity.image])
        if (!image.ok) {
          const pulled = await run(['pull', '--platform', identity.platform, identity.image], { timeout: 600_000 })
          if (!pulled.ok) return failure('browser_image_failed', pulled.error)
        }
        // The proxy network must exist for docker create, including stopped VMs.
        if (hasBoundExit(vm.proxy) && !start) {
          const eg = await ensureEgress(projectRoot, vm.proxy)
          if (!eg.ok) return failure('browser_egress_failed', eg.error || '浏览器出口未就绪')
        }
        const made = await run(buildBrowserCreateArgs(vm, projectRoot, identity, hostOf))
        if (!made.ok) return failure('browser_create_failed', made.error)
        doc = await inspect(vm, run)
      }
      const fresh = currentVm(vm, projectRoot)
      if (!fresh || browserConfigHash(fresh, identity) !== expected) {
        await run(['rm', '-f', browserName(vm.id)])
        return failure('browser_binding_changed', 'VM 绑定已变更，请重试')
      }
      if (start && !doc?.State?.Running) {
        const started = await run(['start', browserName(vm.id)])
        if (!started.ok) return failure('browser_start_failed', started.error)
        doc = await inspect(vm, run)
        const latest = currentVm(vm, projectRoot)
        if (!latest || browserConfigHash(latest, identity) !== expected) {
          await run(['stop', '-t', '3', browserName(vm.id)])
          return failure('browser_binding_changed', 'VM 绑定已变更，请重试')
        }
      }
      return publicState(vm, identity, doc)
    } catch (e) {
      return failure('browser_failed', e.message)
    }
  })
}

export async function readVmBrowser(vm, projectRoot, { run = docker } = {}) {
  if (vm.node_id) return { ok: true, status: 'unsupported', vm_id: vm.id }
  if (!browserEnabled()) return { ok: true, status: 'disabled', vm_id: vm.id }
  const identity = readJson(path.join(browserDir(projectRoot, vm.id), 'identity.json'))
  if (!identity) return { ok: true, status: 'uncreated', vm_id: vm.id }
  return publicState(vm, identity, await inspect(vm, run))
}

export async function stopVmBrowser(vm, { remove = false, run = docker, projectRoot } = {}) {
  if (vm.node_id) return { ok: true, skipped: true }
  const operation = async () => {
    try {
      const doc = await inspect(vm, run)
      if (!doc || (!remove && !doc.State.Running)) return { ok: true }
      const r = await run(remove ? ['rm', '-f', browserName(vm.id)] : ['stop', '-t', '5', browserName(vm.id)])
      return r.ok ? { ok: true } : failure('browser_stop_failed', r.error)
    } catch (e) {
      return failure('browser_stop_failed', e.message)
    }
  }
  return projectRoot ? serialize(vm, projectRoot, operation) : operation()
}

/** Called before the synchronous proxy writer: a running browser must lose the old exit. */
export function stopBrowserBeforeProxyChange(vm, projectRoot) {
  if (vm.node_id || !fs.existsSync(path.join(browserDir(projectRoot, vm.id), 'identity.json'))) return
  let doc
  try {
    doc = JSON.parse(
      execFileSync('docker', ['inspect', browserName(vm.id)], {
        encoding: 'utf8',
        timeout: 8000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )[0]
  } catch (error) {
    // Inspect stderr is captured privately; fail closed if Docker is unavailable.
    if (/no such (object|container)/i.test(String(error.stderr || ''))) return
    throw new Error('无法检查浏览器状态，已取消网络出口变更')
  }
  if (!doc.State.Running) return
  if (doc.Config.Labels['kin.browser.vm_id'] !== vm.id) throw new Error('browser container ownership mismatch')
  execFileSync('docker', ['stop', '-t', '5', browserName(vm.id)], { timeout: 15_000, stdio: 'ignore' })
}

export function validateBrowserAuthUrl(raw) {
  const url = new URL(String(raw))
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !(
      (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize') ||
      (url.hostname === 'claude.ai' && url.pathname === '/oauth/authorize')
    )
  ) {
    throw new Error('只允许在配套浏览器中打开 Claude OAuth 授权链接')
  }
  return url.href
}

export async function openVmBrowserAuth(vm, projectRoot, rawUrl, opts = {}) {
  let url
  try {
    url = validateBrowserAuthUrl(rawUrl)
  } catch (e) {
    return failure('browser_url_invalid', e.message)
  }
  const state = await ensureVmBrowser(vm, projectRoot, { ...opts, start: true })
  if (!state.ok || state.skipped) return state
  const run = opts.run || docker
  // The display and Chromium start after Docker reports Running=true.
  let ready = false
  for (let i = 0; i < 60; i++) {
    if ((await run(['exec', browserName(vm.id), 'test', '-L', '/config/chromium/SingletonSocket'])).ok) {
      ready = true
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!ready) return failure('browser_start_timeout', 'Chromium 仍在启动，请稍后重试')
  // Start the secondary process with the same profile. Chromium forwards the URL
  // to its existing singleton instead of creating a new anonymous session.
  const opened = await run(
    [
      'exec',
      '--user',
      'abc',
      '--env',
      'HOME=/config',
      '--env',
      'XDG_RUNTIME_DIR=/config/.XDG',
      '--env',
      'WAYLAND_DISPLAY=wayland-1',
      browserName(vm.id),
      '/usr/bin/chromium',
      '--no-sandbox',
      '--user-data-dir=/config/chromium',
      '--ozone-platform=wayland',
      url,
    ],
    { timeout: 20_000 },
  )
  if (!opened.ok) return failure('browser_open_failed', opened.error)
  return state
}

export async function waitVmBrowserReady(vm, projectRoot) {
  const target = await browserProxyTarget(vm, projectRoot)
  if (!target) return false
  for (let i = 0; i < 45; i++) {
    try {
      const reply = await fetch(`http://${target.hostname}:${target.port}${browserBasePath(vm.id)}`, {
        headers: { Authorization: target.authorization },
        signal: AbortSignal.timeout(1500),
      })
      await reply.body?.cancel()
      if (reply.ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Private target for the authenticated HTTP/WS gateway. No port or password in panel JSON. */
export async function browserProxyTarget(vm, projectRoot, { run = docker } = {}) {
  const identity = readJson(path.join(browserDir(projectRoot, vm.id), 'identity.json'))
  if (!identity || !hasBoundExit(vm.proxy)) return null
  const doc = await inspect(vm, run)
  if (!doc?.State?.Running || doc.Config.Labels['kin.browser.config'] !== browserConfigHash(vm, identity)) return null
  const binding = doc.NetworkSettings?.Ports?.['3000/tcp']?.find((p) => p.HostIp === '127.0.0.1')
  if (!binding || !/^\d+$/.test(binding.HostPort)) return null
  return {
    hostname: '127.0.0.1',
    port: Number(binding.HostPort),
    authorization: `Basic ${Buffer.from(`chromium:${identity.password}`).toString('base64')}`,
  }
}
