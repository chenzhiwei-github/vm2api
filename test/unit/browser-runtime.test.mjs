import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  browserName,
  browserDir,
  ensureBrowserIdentity,
  ensureVmBrowser,
  stopVmBrowser,
  browserProxyTarget,
  validateBrowserAuthUrl,
} from '../../src/lib/vm/browser-runtime.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-browser-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vm = {
    id: 'vm-browser-test',
    timezone: 'America/New_York',
    locale: 'en_US.UTF-8',
    proxy: { id: 'px-one', host: 'proxy', port: 1080 },
  }
  fs.mkdirSync(path.join(root, 'vms'))
  const save = (v = vm) => fs.writeFileSync(path.join(root, 'vms', `${v.id}.json`), JSON.stringify(v))
  save()
  const docs = new Map()
  const calls = []
  const run = async (args) => {
    calls.push(args)
    if (args[0] === 'image' || args[0] === 'pull') return { ok: true, stdout: '{}' }
    if (args[0] === 'inspect') {
      const doc = docs.get(args[1])
      return doc ? { ok: true, stdout: JSON.stringify([doc]) } : { ok: false, error: 'No such object' }
    }
    if (args[0] === 'create') {
      const labels = {}
      for (let i = 0; i < args.length; i++)
        if (args[i] === '--label') {
          const [key, ...parts] = args[i + 1].split('=')
          labels[key] = parts.join('=')
        }
      docs.set(args[args.indexOf('--name') + 1], {
        Config: { Labels: labels },
        State: { Running: false },
        NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '39123' }] } },
      })
      return { ok: true, stdout: 'container-id' }
    }
    if (args[0] === 'rm') docs.delete(args.at(-1))
    if (args[0] === 'start') docs.get(args[1]).State.Running = true
    if (args[0] === 'stop') docs.get(args.at(-1)).State.Running = false
    return { ok: true, stdout: '' }
  }
  return { root, vm, save, run, calls, docs, opts: { run, hostOf: (p) => p, ensureEgress: async () => ({ ok: true }) } }
}

test('two VMs have isolated persisted environments, profiles and credentials', async (t) => {
  const f = fixture(t)
  const other = { ...f.vm, id: 'vm-other' }
  f.save(other)
  const a = await ensureVmBrowser(f.vm, f.root, f.opts)
  const b = await ensureVmBrowser(other, f.root, f.opts)
  assert.equal(a.status, 'stopped')
  assert.notEqual(a.environment_id, b.environment_id)
  const ia = ensureBrowserIdentity(f.vm, f.root)
  const ib = ensureBrowserIdentity(other, f.root)
  assert.notEqual(ia.machine_id, ib.machine_id)
  assert.notEqual(ia.password, ib.password)
  const creates = f.calls.filter((a) => a[0] === 'create')
  assert.ok(creates[0].some((arg) => arg.includes(`/vms/${f.vm.id}/browser/profile`)))
  assert.ok(!creates[0].some((arg) => arg.includes(`/vms/${other.id}/`)))
  assert.equal(creates[0][creates[0].indexOf('--network') + 1], 'kin-eg-px-one')
  assert.ok(creates[0].includes('127.0.0.1::3000'))
  assert.ok(!creates[0].some((a) => a.includes('--proxy-server')))
  assert.ok(!JSON.stringify(a).includes(ia.password))
})

test('stop, remove and recreate retain the same identity and login data', async (t) => {
  const f = fixture(t)
  const a = await ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })
  assert.equal(a.status, 'running')
  const cookie = path.join(browserDir(f.root, f.vm.id), 'profile', 'login-sentinel')
  fs.writeFileSync(cookie, 'persistent-login')
  await stopVmBrowser(f.vm, { run: f.run, projectRoot: f.root })
  await stopVmBrowser(f.vm, { run: f.run, projectRoot: f.root, remove: true })
  const b = await ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })
  assert.equal(b.environment_id, a.environment_id)
  assert.equal(fs.readFileSync(cookie, 'utf8'), 'persistent-login')
})

test('rebinding invalidates gateway access and recreates browser on the new exit', async (t) => {
  const f = fixture(t)
  const a = await ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })
  assert.ok(await browserProxyTarget(f.vm, f.root, { run: f.run }))
  f.vm.proxy = { id: 'px-two', host: 'new-proxy', port: 1080 }
  f.save()
  assert.equal(await browserProxyTarget(f.vm, f.root, { run: f.run }), null)
  const b = await ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })
  assert.equal(b.environment_id, a.environment_id)
  const created = f.calls.filter((a) => a[0] === 'create').at(-1)
  assert.equal(created[created.indexOf('--network') + 1], 'kin-eg-px-two')
})

test('unbound VM gets a stopped browser with no network; opening fails closed', async (t) => {
  const f = fixture(t)
  f.vm.proxy = null
  f.save()
  const stopped = await ensureVmBrowser(f.vm, f.root, f.opts)
  assert.equal(stopped.status, 'stopped')
  const args = f.calls.find((a) => a[0] === 'create')
  assert.equal(args[args.indexOf('--network') + 1], 'none')
  const denied = await ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })
  assert.equal(denied.code, 'proxy_required')
  assert.ok(!f.calls.some((a) => a[0] === 'start'))
})

test('concurrent opens cannot create two containers or rotate identity', async (t) => {
  const f = fixture(t)
  const [a, b] = await Promise.all([1, 2].map(() => ensureVmBrowser(f.vm, f.root, { ...f.opts, start: true })))
  assert.equal(a.environment_id, b.environment_id)
  assert.equal(f.calls.filter((a) => a[0] === 'create').length, 1)
})

test('deleted VM during image pull cannot leave a running orphan', async (t) => {
  const f = fixture(t)
  const run = async (args) => {
    if (args[0] === 'image') return { ok: false, error: 'missing image' }
    if (args[0] === 'pull') {
      fs.unlinkSync(path.join(f.root, 'vms', `${f.vm.id}.json`))
      return { ok: true }
    }
    return f.run(args)
  }
  const result = await ensureVmBrowser(f.vm, f.root, { ...f.opts, run, start: true })
  assert.equal(result.code, 'browser_binding_changed')
  assert.equal(f.docs.size, 0)
  assert.ok(!f.calls.some((a) => a[0] === 'start'))
})

test('corrupt identity fails instead of silently replacing browser login identity', (t) => {
  const f = fixture(t)
  ensureBrowserIdentity(f.vm, f.root)
  const file = path.join(browserDir(f.root, f.vm.id), 'identity.json')
  fs.writeFileSync(file, '{broken')
  assert.throws(() => ensureBrowserIdentity(f.vm, f.root))
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken')
})

test('Docker inspection failure cannot be treated as successful browser removal', async (t) => {
  const f = fixture(t)
  const result = await stopVmBrowser(f.vm, {
    remove: true,
    run: async () => ({ ok: false, error: 'daemon unavailable' }),
  })
  assert.equal(result.ok, false)
})

test('browser accepts only official Claude OAuth authorization URLs and safe VM IDs', () => {
  assert.ok(validateBrowserAuthUrl('https://claude.com/cai/oauth/authorize?state=abc'))
  for (const url of [
    'http://claude.com/cai/oauth/authorize',
    'https://evil.example/',
    'https://claude.com:444/cai/oauth/authorize',
    'https://claude.com/cai/oauth/authorize/../../',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => validateBrowserAuthUrl(url))
  }
  assert.throws(() => browserName('../../escape'))
  assert.notEqual(browserName('VM-one'), browserName('vm-one'))
})
