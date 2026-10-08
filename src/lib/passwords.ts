// Password hashing — server-side only.
//
// scrypt, from node:crypto. No native dependency to build, and it is memory-hard,
// so it is not the kind of hash a GPU farm walks through the way a bare SHA-256
// would be.
//
// The digest is SELF-DESCRIBING — `scrypt$N$r$p$salt$hash` — rather than a bare
// hex string. Storing the cost parameters alongside the hash is what makes them
// raisable later: a future revision can bump N and still verify every password
// already in the database by reading the parameters that hash was written with.
// A fixed constant here would have made that a breaking change.
//
// Deliberately NOT imported by anything under src/components — this must never
// reach the browser bundle.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const N = 16_384
const R = 8
const P = 1
const KEYLEN = 64
const SALT_BYTES = 16

// scrypt's memory requirement grows with N; the default `maxmem` (32 MB) is below
// what N=16384,r=8 needs, and the call fails with ERR_CRYPTO_INVALID_SCRYPT_PARAMS
// rather than degrading. Raised explicitly, with headroom for N to double.
const MAX_MEM = 128 * N * R * 2

function derive(password: string, salt: Buffer, n: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keylen, { N: n, r, p, maxmem: MAX_MEM }, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

/** Hash a password for storage. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await derive(password, salt, N, R, P, KEYLEN)
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * Check a password against a stored digest.
 *
 * Returns false for a malformed/absent digest rather than throwing — a caller
 * must not be able to turn a broken row into a 500 and learn which accounts have
 * one. Comparison is constant-time so the response cannot be timed to reveal how
 * many leading bytes matched.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  // A digest whose parameters are not sane is treated as unusable rather than fed
  // to scrypt, where a huge N is a denial-of-service on our own event loop.
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false
  if (n < 1024 || n > 1_048_576 || n & (n - 1)) return false
  if (r < 1 || r > 64 || p < 1 || p > 16) return false

  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(parts[4], 'hex')
    expected = Buffer.from(parts[5], 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false

  try {
    const actual = await derive(password, salt, n, r, p, expected.length)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * Minimum password policy.
 *
 * Length only, plus a check against a handful of passwords that are so common
 * that length alone would not save them. Composition rules ("one symbol, one
 * digit") push people toward `Password1!`, which is why they are not used here —
 * the target audience is investors and agents, not attackers.
 */
export const PASSWORD_MIN_LENGTH = 10

const OBVIOUS = new Set([
  'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
  'letmein123', 'welcome123', 'abcd123456', 'sqftlabsqftlab', 'administrator',
])

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'A password is required.'
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > 200) return 'Password must be at most 200 characters.'
  if (OBVIOUS.has(password.toLowerCase())) return 'That password is too common. Choose another.'
  return null
}

/** Shape check for an email address. Deliberately permissive. */
export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
}
