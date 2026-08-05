function scaledNumber(value: number, divisor: number, suffix: string) {
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value / divisor)}${suffix}`
}

export function formatTokenCount(value: number) {
  const amount = Number.isFinite(value) ? Math.max(0, value) : 0
  if (amount <= 1_000_000) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(amount)
  }
  if (amount < 1_000_000_000) return scaledNumber(amount, 1_000_000, 'M')
  return scaledNumber(amount, 1_000_000_000, 'B')
}
