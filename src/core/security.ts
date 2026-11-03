// Security primitives: password hashing (scrypt), TOTP (RFC 6238), field encryption (AES-256-GCM),
// keyed hashing, random tokens and the password policy. Node built-ins only.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------- application key ----------

/**
 * 32-byte key used to encrypt MFA secrets and key the audit chain.
 * Production: APP_SECRET (64 hex chars or base64 of 32 bytes) from AWS Secrets Manager / SSM.
 * Otherwise a key file next to the database is created once with 0600 permissions.
 */
export function loadAppKey(dbPath: string): Buffer {
  const env = process.env.APP_SECRET?.trim();
  if (env) {
    const k = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, 'hex') : Buffer.from(env, 'base64');
    if (k.length !== 32) throw new Error('APP_SECRET must be 32 bytes (64 hex characters or base64)');
    return k;
  }
  if (dbPath === ':memory:') return randomBytes(32);
  const file = process.env.APP_KEY_FILE ?? `${dirname(dbPath)}/app.key`;
  if (existsSync(file)) {
    const k = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error(`Key file ${file} is corrupt`);
    return k;
  }
  mkdirSync(dirname(file), { recursive: true });
  const k = randomBytes(32);
  writeFileSync(file, k.toString('hex') + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
  return k;
}

// ---------- passwords ----------

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 96 * 1024 * 1024 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password.normalize('NFKC'), salt, keylen, { N, r, p, maxmem: SCRYPT.maxmem }, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Synchronous variant for use inside a database transaction (administrator resets). */
export function hashPasswordSync(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/** Hash of a random password; verified against when the user does not exist so timing does not reveal it. */
let dummyHash: Promise<string> | null = null;
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) {
    dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    await verifyPassword(password, await dummyHash);
    return false;
  }
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), Number(N), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', 'qwerty', 'qwerty123', 'letmein', 'welcome', 'welcome1',
  'admin', 'administrator', 'changeme', 'iloveyou', '123456', '12345678', '123456789', '1234567890', 'seaport', 'seaportglobal', 'abc123']);

/** NIST SP 800-63B style policy: length over composition, a block-list, no username, max length to bound hashing cost. */
export function passwordProblems(password: string, username: string, name = ''): string[] {
  const out: string[] = [];
  if (typeof password !== 'string') return ['Password is required'];
  if (password.length < 12) out.push('Use at least 12 characters');
  if (password.length > 128) out.push('Use at most 128 characters');
  const lower = password.toLowerCase();
  const core = lower.replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
  if (COMMON.has(lower) || COMMON.has(core)) out.push('This password is too common');
  if (username && lower.includes(username.toLowerCase())) out.push('Do not include your username');
  for (const part of name.toLowerCase().split(/\s+/)) if (part.length >= 4 && lower.includes(part)) { out.push('Do not include your name'); break; }
  if (/^(.)\1+$/.test(password)) out.push('Do not repeat one character');
  if (new Set(password).size < 5) out.push('Use more different characters');
  return out;
}

export function randomPassword(): string {
  // 18 chars from an unambiguous alphabet (~105 bits)
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(18);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

// ---------- tokens ----------

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hmac = (key: Buffer, s: string) => createHmac('sha256', key).update(s).digest('hex');

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- field encryption ----------

export function encrypt(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function decrypt(key: Buffer, blob: string): string {
  if (!blob.startsWith('v1:')) throw new Error('Unsupported ciphertext');
  const raw = Buffer.from(blob.slice(3), 'base64');
  const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

// ---------- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ----------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(randomBytes(20));

export function totpAt(secretB32: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const totpStep = (ms = Date.now()) => Math.floor(ms / 30_000);

/** Returns the matched time step (to block replay), or null. Accepts one step of clock drift either way. */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, ms = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(ms);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (safeEqual(totpAt(secretB32, step), code)) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer = 'Seaport Global') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export function newRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(6)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}
