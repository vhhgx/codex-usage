export function scheduleActivityRefresh(refresh: () => void, intervalMs = 30_000) {
  const timer = setInterval(refresh, intervalMs)
  return () => clearInterval(timer)
}
