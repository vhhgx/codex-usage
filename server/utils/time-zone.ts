interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function parts(date: Date, timeZone: string): ZonedParts {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).map(part => [part.type, part.value]))
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second)
  }
}

function zonedDateTime(value: ZonedParts, timeZone: string) {
  const desired = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second)
  let candidate = desired
  for (let index = 0; index < 3; index++) {
    const actual = parts(new Date(candidate), timeZone)
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second)
    candidate += desired - represented
  }
  return new Date(candidate)
}

export function zonedDateStart(value: string, timeZone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) throw new Error('Invalid date key')
  return zonedDateTime({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: 0, minute: 0, second: 0 }, timeZone)
}

export function zonedHourStart(value: string, hour: number, timeZone: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match || !Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error('Invalid zoned hour')
  return zonedDateTime({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour, minute: 0, second: 0 }, timeZone)
}

export function zonedDateKey(date: Date, timeZone: string) {
  const value = parts(date, timeZone)
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`
}

export function startOfZoned(date: Date, unit: 'hour' | 'day' | 'week' | 'month' | 'year', timeZone: string) {
  const value = parts(date, timeZone)
  let calendar = new Date(Date.UTC(value.year, value.month - 1, value.day))
  if (unit === 'week') calendar = new Date(calendar.getTime() - ((calendar.getUTCDay() + 6) % 7) * 86400_000)
  if (unit === 'month' || unit === 'year') calendar.setUTCDate(1)
  if (unit === 'year') calendar.setUTCMonth(0)
  return zonedDateTime({
    year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(),
    hour: unit === 'hour' ? value.hour : 0, minute: 0, second: 0
  }, timeZone)
}
