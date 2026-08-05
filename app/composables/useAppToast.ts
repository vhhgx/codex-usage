import { clientRandomUUID } from '#shared/utils/client-random'

export type AppToastTone = 'success' | 'error' | 'info'

export interface AppToastItem {
  id: string
  message: string
  tone: AppToastTone
}

export function useAppToast() {
  const items = useState<AppToastItem[]>('app-toast-items', () => [])

  function dismiss(id: string) {
    items.value = items.value.filter(item => item.id !== id)
  }

  function show(message: string, tone: AppToastTone = 'info', duration = tone === 'error' ? 7000 : 4200) {
    const id = clientRandomUUID()
    items.value = [...items.value.slice(-3), { id, message, tone }]
    if (import.meta.client) window.setTimeout(() => dismiss(id), duration)
    return id
  }

  return { items, show, dismiss }
}
