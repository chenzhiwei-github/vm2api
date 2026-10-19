import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { apiBase } from '@/lib/session'

export type BrowserState = {
  status: 'uncreated' | 'stopped' | 'running' | 'disabled' | 'unsupported'
  environment_id?: string
  timezone?: string
  locale?: string
  view_path?: string
}

export function browserQueryOptions(vmId: string, enabled = true) {
  return queryOptions({
    queryKey: ['vm-browser', vmId] as const,
    queryFn: () =>
      api<BrowserState>(`/api/panel/vms/${encodeURIComponent(vmId)}/browser`),
    enabled,
    staleTime: 5_000,
    refetchInterval: 10_000,
    retry: false,
  })
}

export function browserUrl(path: string) {
  return new URL(`${apiBase()}${path}`, location.origin).href
}

/** Open synchronously from the click so browser popup blockers do not eat it. */
export function placeholderWindow() {
  const popup = window.open('about:blank', '_blank')
  if (popup) {
    popup.opener = null
    popup.document.title = '正在启动 VM 浏览器…'
    popup.document.body.textContent = '正在启动独立 Chromium，请稍候…'
  }
  return popup
}
