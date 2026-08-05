import { DeleteObjectsCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import type { H3Event } from 'h3'
import { decryptSecret, secretEncryptionKey } from './hub-crypto'

let client: S3Client | null = null

function storageConfig(event?: H3Event) {
  const config = useRuntimeConfig(event)
  const bucket = String(config.s3Bucket || '').trim()
  const accessKeyId = String(config.s3AccessKeyId || '').trim()
  const secretAccessKey = String(config.s3SecretAccessKey || '').trim()
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw createError({ statusCode: 503, message: '未完整配置 S3/MinIO 日志存储' })
  }
  return { config, bucket, accessKeyId, secretAccessKey }
}

function useS3(event?: H3Event) {
  if (client) return client
  const { config, accessKeyId, secretAccessKey } = storageConfig(event)
  client = new S3Client({
    region: String(config.s3Region || 'us-east-1'),
    endpoint: String(config.s3Endpoint || '').trim() || undefined,
    forcePathStyle: Boolean(config.s3ForcePathStyle),
    credentials: { accessKeyId, secretAccessKey }
  })
  return client
}

export async function storeEncryptedBody(
  event: H3Event,
  requestId: string,
  kind: 'request' | 'response',
  body: Buffer | string,
  contentType: string
) {
  const source = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)])
  return storeEncryptedStream(event, requestId, kind, source, contentType)
}

export async function storeEncryptedStream(
  event: H3Event,
  requestId: string,
  kind: 'request' | 'response',
  source: AsyncIterable<Uint8Array>,
  contentType: string
) {
  const { bucket } = storageConfig(event)
  const date = new Date().toISOString().slice(0, 10)
  const key = `${date}/${requestId}/${kind}.enc`
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', secretEncryptionKey(event), iv)
  async function* encrypted() {
    yield Buffer.from('ZH02')
    yield iv
    for await (const chunk of source) yield cipher.update(chunk)
    yield cipher.final()
    yield cipher.getAuthTag()
  }
  const upload = new Upload({
    client: useS3(event),
    params: {
      Bucket: bucket,
      Key: key,
      Body: Readable.from(encrypted()),
      ContentType: 'application/octet-stream',
      ServerSideEncryption: 'AES256',
      Metadata: { originalContentType: contentType.slice(0, 512), encoding: 'aes-256-gcm-binary-v2' }
    }
  })
  await upload.done()
  return key
}

export async function readEncryptedBody(event: H3Event, key: string) {
  const { bucket } = storageConfig(event)
  const response = await useS3(event).send(new GetObjectCommand({ Bucket: bucket, Key: key }))
  const encrypted = Buffer.from(await response.Body?.transformToByteArray() || [])
  if (encrypted.subarray(0, 4).toString() === 'ZH02') {
    const iv = encrypted.subarray(4, 16)
    const tag = encrypted.subarray(encrypted.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', secretEncryptionKey(event), iv)
    decipher.setAuthTag(tag)
    return {
      body: Buffer.concat([decipher.update(encrypted.subarray(16, -16)), decipher.final()]),
      contentType: response.Metadata?.originalcontenttype || 'application/octet-stream'
    }
  }
  return {
    body: Buffer.from(decryptSecret(encrypted.toString(), event), 'base64'),
    contentType: response.Metadata?.originalcontenttype || 'application/octet-stream'
  }
}

export async function deleteEncryptedBodies(event: H3Event | undefined, keys: string[]) {
  const objects = [...new Set(keys.filter(Boolean))]
  if (!objects.length) return 0
  const { bucket } = storageConfig(event)
  for (let offset = 0; offset < objects.length; offset += 1000) {
    const batch = objects.slice(offset, offset + 1000)
    const result = await useS3(event).send(new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true }
    }))
    if (result.Errors?.length) throw new Error(`无法删除 ${result.Errors.length} 个过期正文对象`)
  }
  return objects.length
}

export async function checkObjectStorage(event?: H3Event) {
  const { bucket } = storageConfig(event)
  await useS3(event).send(new HeadBucketCommand({ Bucket: bucket }))
}
