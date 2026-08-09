export default defineNuxtPlugin(() => {
  let activeSurface: HTMLElement | null = null
  let previouslyFocused: HTMLElement | null = null

  function focusableWithin(surface: HTMLElement) {
    return [...surface.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter((element) => {
      const style = getComputedStyle(element)
      return style.visibility !== 'hidden' && style.display !== 'none' && element.getClientRects().length > 0
    })
  }

  function findSurface() {
    return document.querySelector<HTMLElement>(
      '.admin-modal-backdrop [role="dialog"], .log-drawer-backdrop > .log-drawer, .modal-overlay [role="dialog"]'
    )
  }

  // Existing pages own their open/close state; this layer only supplies the shared keyboard contract.
  function syncSurface() {
    const next = findSurface()
    if (next === activeSurface) return
    if (next) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
      activeSurface = next
      requestAnimationFrame(() => focusableWithin(next)[0]?.focus())
      return
    }
    const restore = previouslyFocused
    activeSurface = null
    previouslyFocused = null
    requestAnimationFrame(() => restore?.isConnected && restore.focus())
  }

  function handleKeydown(event: KeyboardEvent) {
    const surface = activeSurface || findSurface()
    if (!surface) return
    if (event.key === 'Escape') {
      event.preventDefault()
      const close = surface.querySelector<HTMLButtonElement>(
        '[aria-label="关闭"], [aria-label*="关闭"], [title="关闭"], [title*="关闭"], button.icon-button'
      )
      close?.click()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = focusableWithin(surface)
    const first = focusable.at(0)
    const last = focusable.at(-1)
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  const observer = new MutationObserver(syncSurface)
  observer.observe(document.body, { childList: true, subtree: true })
  document.addEventListener('keydown', handleKeydown, true)
  syncSurface()

  return {
    provide: {
      modalA11y: { syncSurface }
    }
  }
})
