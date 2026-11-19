import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be 32 bytes");
}

/** AES-256-GCM. Output layout: iv (12) | tag (16) | ciphertext. `aad` binds it to its context. */
export function seal(key: Buffer, plaintext: Buffer, aad: string): Buffer {
  checkKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Throws if the data was tampered with, or the key or AAD do not match. */
export function open(key: Buffer, sealed: Buffer, aad: string): Buffer {
  checkKey(key);
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}
