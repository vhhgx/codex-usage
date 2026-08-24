export function maskHubKey(prefix: string, lastFour: string) {
  const head = prefix.slice(0, 6)
  const tail = lastFour.slice(-4)
  return `${head}********${tail}`
}
