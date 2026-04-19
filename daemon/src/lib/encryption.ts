// ---------------------------------------------------------------------------
// AES-256-GCM encryption (CDD §8.3)
//
// Key stored at ~/.vibe-harness/encryption.key (256-bit random, 0600).
// TODO: macOS Keychain / Linux libsecret for post-MVP.
// ---------------------------------------------------------------------------

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { getConfigDir } from './config.js';

const KEY_FILE = 'encryption.key';
const KEY_BYTES = 32; // 256-bit
const IV_BYTES = 12;  // GCM standard
const AUTH_TAG_BYTES = 16;
const ALGORITHM = 'aes-256-gcm';

/**
 * Get or create the AES-256 encryption key.
 * Stored at ~/.vibe-harness/encryption.key with 0600 permissions.
 */
export function getOrCreateEncryptionKey(): Buffer {
  const keyPath = join(getConfigDir(), KEY_FILE);

  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }

  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key, { mode: 0o600 });
  // Ensure permissions on existing filesystems
  chmodSync(keyPath, 0o600);
  return key;
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Returns base64-encoded string: iv (12B) + authTag (16B) + ciphertext.
 */
export function encrypt(plaintext: string, key?: Buffer): string {
  const encKey = key ?? getOrCreateEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encKey, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Pack: iv + authTag + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded ciphertext produced by encrypt().
 */
export function decrypt(ciphertext: string, key?: Buffer): string {
  const encKey = key ?? getOrCreateEncryptionKey();
  const packed = Buffer.from(ciphertext, 'base64');

  const iv = packed.subarray(0, IV_BYTES);
  const authTag = packed.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const encrypted = packed.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, encKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
