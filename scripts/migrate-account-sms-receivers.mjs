import { createCipheriv, randomBytes, randomUUID } from 'node:crypto'
import postgres from 'postgres'

const databaseUrl = String(process.env.NUXT_DATABASE_URL || '').trim()
const encryptionKey = Buffer.from(String(process.env.NUXT_ENCRYPTION_KEY || '').trim(), 'base64')
if (!databaseUrl) throw new Error('NUXT_DATABASE_URL is required')
if (encryptionKey.length !== 32) throw new Error('NUXT_ENCRYPTION_KEY must decode to 32 bytes')

function encryptFetchUrl(value, id) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  cipher.setAAD(Buffer.from(`zephyr-context-secret:sms-receiver:${id}:fetch-url:v2`, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `v2.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`
}

function legacyReceiver(row) {
  const phone = String(row.phone || '').trim()
  const phoneKey = phone.replace(/\D/g, '')
  if (phoneKey.length < 6 || phoneKey.length > 15) throw new Error('invalid phone number')
  const url = new URL(String(row.sms_url || '').trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid provider URL')
  url.hash = ''
  return { phone, phoneKey, url }
}

const sql = postgres(databaseUrl, { max: 1 })
let migrated = 0
let skipped = 0
let failed = 0
try {
  const rows = await sql`
    select id, phone, sms_url, created_by
    from account_vault_entries
    where nullif(phone, '') is not null and nullif(sms_url, '') is not null
    order by created_at, id
  `
  for (const row of rows) {
    try {
      const value = legacyReceiver(row)
      await sql.begin(async transaction => {
        let [receiver] = await transaction`
          select id from sms_receivers where phone_key = ${value.phoneKey} limit 1
        `
        if (!receiver) {
          const id = randomUUID()
          ;[receiver] = await transaction`
            insert into sms_receivers (
              id, phone, phone_key, provider_host, encrypted_fetch_url, note, status, created_by, updated_by
            ) values (
              ${id}, ${value.phone}, ${value.phoneKey}, ${value.url.hostname},
              ${encryptFetchUrl(value.url.toString(), id)}, ${'由旧账号资料迁移'}, ${'active'},
              ${row.created_by}, ${row.created_by}
            ) returning id
          `
        }
        const [existingBinding] = await transaction`
          select id from sms_receiver_bindings where account_id = ${row.id} limit 1
        `
        if (!existingBinding) {
          const used = await transaction`
            select slot from sms_receiver_bindings where receiver_id = ${receiver.id} order by slot
          `
          const slot = [1, 2, 3].find(candidate => !used.some(item => item.slot === candidate))
          if (!slot) throw new Error('receiver already has three bindings')
          await transaction`
            insert into sms_receiver_bindings (receiver_id, account_id, slot, created_by)
            values (${receiver.id}, ${row.id}, ${slot}, ${row.created_by})
          `
        }
        await transaction`
          update account_vault_entries set phone = null, sms_url = null, updated_at = now() where id = ${row.id}
        `
      })
      migrated++
    } catch {
      failed++
    }
  }
  const [remaining] = await sql`
    select count(*)::int as count from account_vault_entries where nullif(sms_url, '') is not null
  `
  skipped = Number(remaining?.count || 0)
  console.log(JSON.stringify({ migrated, failed, remainingPlaintextUrls: skipped }))
  if (failed || skipped) process.exitCode = 1
} finally {
  await sql.end()
}
