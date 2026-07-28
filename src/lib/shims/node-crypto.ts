/**
 * Browser shim for Node's `crypto`, used by gramjs (telegram).
 * gramjs ships its own WebCrypto-based implementation for browsers
 * (telegram/crypto/crypto). We re-export it and also expose a `default`
 * export because gramjs does `import * as crypto from "crypto"` and then
 * reads `.default.randomBytes(...)`.
 */
import * as gramCrypto from "telegram/crypto/crypto";

const webcrypto: Crypto =
  (globalThis as unknown as { crypto: Crypto }).crypto;

export const randomBytes = (n: number): Uint8Array => {
  const bytes = new Uint8Array(n);
  webcrypto.getRandomValues(bytes);
  return bytes;
};

export const getRandomValues = <T extends ArrayBufferView | null>(a: T): T =>
  webcrypto.getRandomValues(a as never) as T;

export const subtle = webcrypto.subtle;
export const randomUUID = () => webcrypto.randomUUID();

export const createHash = gramCrypto.createHash;
export const createCipheriv = gramCrypto.createCipheriv;
export const createDecipheriv = gramCrypto.createDecipheriv;
export const pbkdf2Sync = gramCrypto.pbkdf2Sync;
export const Hash = gramCrypto.Hash;
export const CTR = gramCrypto.CTR;
export const Counter = gramCrypto.Counter;

const api = {
  ...gramCrypto,
  randomBytes,
  getRandomValues,
  randomUUID,
  subtle,
  webcrypto,
};

export default api;
