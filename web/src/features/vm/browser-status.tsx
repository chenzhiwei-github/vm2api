import { useQuery } from '@tanstack/react-query'
import type { Vm } from '@/types/panel-vm'
import { Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isCodexVm } from '@/lib/vm-kind'
import { browserQueryOptions } from '@/features/vm/browser-state'
import { useVmPerms } from '@/features/vm/vm-perms'

export function BrowserStatus({ vm }: { vm: Vm }) {
  const allowed = useVmPerms().credential && !isCodexVm(vm)
  const state = useQuery(browserQueryOptions(vm.id, allowed))
  if (!allowed) return null
  const status = state.data?.status
  const running = status === 'running'
  const label = state.isError
    ? '状态未知'
    : !status
      ? '读取中'
      : running
        ? '已开启'
        : status === 'unsupported'
          ? '不支持'
          : status === 'disabled'
            ? '已禁用'
            : '已关闭'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 text-[10px] whitespace-nowrap',
        running && !state.isError && 'text-[color:var(--status-ok)]'
      )}
      title={state.isError ? state.error.message : `Chromium ${label}`}
      aria-label={`Chromium ${label}`}
    >
      <Globe className='size-3' aria-hidden='true' />
      Chromium {label}
    </span>
  )
}
