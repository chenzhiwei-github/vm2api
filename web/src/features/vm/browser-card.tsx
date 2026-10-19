import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  browserQueryOptions,
  browserUrl,
  placeholderWindow,
  type BrowserState,
} from '@/features/vm/browser-state'

const statusLabel: Record<BrowserState['status'], string> = {
  uncreated: '待创建',
  stopped: '已停止',
  running: '运行中',
  disabled: '已禁用',
  unsupported: '远端节点暂不支持',
}

export function BrowserAuthButton({
  vmId,
  authUrl,
  disabled = false,
}: {
  vmId: string
  authUrl: string
  disabled?: boolean
}) {
  const qc = useQueryClient()
  const open = useMutation({
    mutationFn: async (popup: Window | null) => {
      try {
        const state = await api<BrowserState>(
          `/api/panel/vms/${encodeURIComponent(vmId)}/browser/open`,
          {
            method: 'POST',
            body: JSON.stringify({ url: authUrl }),
          }
        )
        if (!state.view_path) throw new Error('配套浏览器未启用')
        if (popup) popup.location.href = browserUrl(state.view_path)
        else toast.error('新窗口被拦截，请允许弹窗后重试')
      } catch (error) {
        popup?.close()
        throw error
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vm-browser', vmId] })
    },
    onError: (error: Error) => toast.error(error.message),
  })
  return (
    <Button
      size='sm'
      disabled={disabled || open.isPending}
      loading={open.isPending}
      onClick={() => open.mutate(placeholderWindow())}
    >
      <ExternalLink className='size-3.5' aria-hidden='true' />
      在此 VM 的 Chromium 中授权
    </Button>
  )
}

export function BrowserCard({ vmId }: { vmId: string }) {
  const qc = useQueryClient()
  const queryKey = ['vm-browser', vmId]
  const base = `/api/panel/vms/${encodeURIComponent(vmId)}/browser`
  const state = useQuery(browserQueryOptions(vmId))
  const action = useMutation({
    mutationFn: async ({
      stop,
      popup,
    }: {
      stop?: boolean
      popup?: Window | null
    }) => {
      try {
        const result = await api<BrowserState>(
          `${base}/${stop ? 'stop' : 'start'}`,
          { method: 'POST', body: '{}' }
        )
        if (!stop) {
          if (!result.view_path) throw new Error('配套浏览器未启用')
          if (popup) popup.location.href = browserUrl(result.view_path)
          else toast.error('新窗口被拦截，请允许弹窗后重试')
        }
      } catch (error) {
        popup?.close()
        throw error
      }
    },
    onSuccess: (_, { stop }) => {
      void qc.invalidateQueries({ queryKey })
      if (stop) toast.success('Chromium 已停止，登录数据已保留')
    },
    onError: (error: Error) => toast.error(error.message),
  })
  const disabled =
    state.data?.status === 'disabled' || state.data?.status === 'unsupported'
  return (
    <Card>
      <CardHeader className='pb-2'>
        <CardTitle className='text-sm'>VM 专属 Chromium</CardTitle>
      </CardHeader>
      <CardContent className='space-y-2 pt-0'>
        <p className='text-xs text-muted-foreground'>
          {state.data
            ? statusLabel[state.data.status]
            : state.isError
              ? state.error.message
              : '读取中…'}
          {state.data?.timezone
            ? ` · ${state.data.timezone} · ${state.data.locale}`
            : ''}
        </p>
        {state.data?.environment_id ? (
          <p className='text-xs break-all text-muted-foreground'>
            环境 ID：{state.data.environment_id}
          </p>
        ) : null}
        <p className='text-xs text-muted-foreground'>
          授权成功后可手动停止 Chromium 以释放资源。停止后保留 Cookie
          和登录状态，不影响 VM 推理与凭证刷新。
        </p>
        <div className='flex flex-wrap gap-2'>
          <Button
            size='sm'
            disabled={disabled || action.isPending}
            loading={action.isPending}
            onClick={() => action.mutate({ popup: placeholderWindow() })}
          >
            打开浏览器
          </Button>
          <Button
            size='sm'
            variant='outline'
            disabled={action.isPending || state.data?.status !== 'running'}
            onClick={() => action.mutate({ stop: true })}
          >
            停止浏览器
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
