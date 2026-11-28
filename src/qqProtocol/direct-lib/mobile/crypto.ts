// Standard Node.js cryptographic & tolerant protobuf helpers for mobile NTLogin.
// QIMEI, O3 EcdhAccess, and token crypto live strictly in the native .node addon.

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  randomBytes,
  type ECDH,
} from 'node:crypto'

export interface EphemeralP256 {
  ecdh: ECDH
  pubCompressed: Buffer   // 33B SEC1
  pubUncompressed: Buffer // 65B SEC1
}

export function generateP256KeyPair(): EphemeralP256 {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    ecdh,
    pubCompressed: Buffer.from(ecdh.getPublicKey(undefined, 'compressed')),
    pubUncompressed: Buffer.from(ecdh.getPublicKey(undefined, 'uncompressed')),
  }
}

/** Raw 32-byte P-256 ECDH shared X coordinate. Accepts 33B compressed or 65B uncompressed SEC1 peer key. */
export function ecdhP256RawX(ecdh: ECDH, peerPubSec1: Buffer): Buffer | null {
  try {
    const shared = ecdh.computeSecret(peerPubSec1)
    return shared.length === 32 ? Buffer.from(shared) : null
  } catch {
    return null
  }
}

/** AES-256-GCM encrypt (empty AAD). Output layout: nonce(12) || ciphertext || tag(16). */
export function aes256GcmSeal(key32: Buffer, plain: Buffer, nonce12: Buffer = randomBytes(12)): Buffer {
  if (key32.length !== 32) throw new Error(`aes256GcmSeal: expected 32B key, got ${key32.length}B`)
  if (nonce12.length !== 12) throw new Error(`aes256GcmSeal: expected 12B nonce, got ${nonce12.length}B`)
  const cipher = createCipheriv('aes-256-gcm', key32, nonce12)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce12, ct, tag])
}

/** AES-256-GCM decrypt (empty AAD). Input layout: nonce(12) || ciphertext || tag(16). */
export function aes256GcmOpen(key32: Buffer, blob: Buffer): Buffer | null {
  if (key32.length !== 32 || blob.length < 28) return null
  try {
    const nonce = blob.subarray(0, 12)
    const tag = blob.subarray(blob.length - 16)
    const ct = blob.subarray(12, blob.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', key32, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
  } catch {
    return null
  }
}

export function md5(data: Buffer | string): Buffer {
  return createHash('md5').update(data).digest()
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

// ---- Tolerant Protobuf reader (preserves repeated fields & never throws on truncated trailers) ----

export interface RawPbField {
  field: number
  wire: number
  bytes: Buffer
  varint: bigint
}

export function readVarintSafe(buf: Buffer, offset: number): [bigint, number] | null {
  let value = 0n
  let shift = 0n
  let i = offset
  while (i < buf.length && shift < 64n) {
    const b = buf[i++]!
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [value, i]
    shift += 7n
  }
  return null
}

export function pbIter(buf: Buffer): RawPbField[] {
  const out: RawPbField[] = []
  let i = 0
  while (i < buf.length) {
    const tagRes = readVarintSafe(buf, i)
    if (!tagRes) break
    const [tag, nextIdx] = tagRes
    i = nextIdx
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (wire === 0) {
      const valRes = readVarintSafe(buf, i)
      if (!valRes) break
      out.push({ field, wire, bytes: Buffer.alloc(0), varint: valRes[0] })
      i = valRes[1]
    } else if (wire === 2) {
      const lenRes = readVarintSafe(buf, i)
      if (!lenRes) break
      const len = Number(lenRes[0])
      const start = lenRes[1]
      if (len < 0 || start + len > buf.length) break
      out.push({ field, wire, bytes: buf.subarray(start, start + len), varint: 0n })
      i = start + len
    } else if (wire === 1) {
      if (i + 8 > buf.length) break
      out.push({ field, wire, bytes: buf.subarray(i, i + 8), varint: 0n })
      i += 8
    } else if (wire === 5) {
      if (i + 4 > buf.length) break
      out.push({ field, wire, bytes: buf.subarray(i, i + 4), varint: 0n })
      i += 4
    } else {
      break
    }
  }
  return out
}

export function pbFirstBytes(buf: Buffer, targetField: number): Buffer | null {
  for (const f of pbIter(buf)) {
    if (f.field === targetField && f.wire === 2) return f.bytes
  }
  return null
}

export function pbFirstU64(buf: Buffer, targetField: number): bigint | null {
  for (const f of pbIter(buf)) {
    if (f.field === targetField && f.wire === 0) return f.varint
  }
  return null
}
