import crypto from "crypto";
import fs from "fs";
import path from "path";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

let _cachedMasterKey: string | null = null;

function getMasterKey(): string {
  if (_cachedMasterKey) return _cachedMasterKey;

  // 1. Check environment variable
  if (process.env.VIBE_HARNESS_MASTER_KEY) {
    _cachedMasterKey = process.env.VIBE_HARNESS_MASTER_KEY;
    return _cachedMasterKey;
  }

  // 2. Check .env.local file
  const envLocalPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envLocalPath)) {
    const content = fs.readFileSync(envLocalPath, "utf-8");
    const match = content.match(/^VIBE_HARNESS_MASTER_KEY=(.+)$/m);
    if (match?.[1]) {
      _cachedMasterKey = match[1].trim();
      process.env.VIBE_HARNESS_MASTER_KEY = _cachedMasterKey;
      return _cachedMasterKey;
    }
  }

  // 3. Auto-generate and persist to .env.local
  const generated = crypto.randomBytes(32).toString("hex");
  const envLine = `VIBE_HARNESS_MASTER_KEY=${generated}\n`;

  if (fs.existsSync(envLocalPath)) {
    const existing = fs.readFileSync(envLocalPath, "utf-8");
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(envLocalPath, prefix + envLine);
  } else {
    fs.writeFileSync(envLocalPath, envLine);
  }

  console.log("[encryption] Auto-generated VIBE_HARNESS_MASTER_KEY and saved to .env.local");
  process.env.VIBE_HARNESS_MASTER_KEY = generated;
  _cachedMasterKey = generated;
  return generated;
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, "sha256");
}

export function encrypt(plaintext: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(getMasterKey(), salt);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // Format: salt:iv:tag:ciphertext (all base64)
  return [
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

export function decrypt(encoded: string): string {
  const [saltB64, ivB64, tagB64, ciphertextB64] = encoded.split(":");
  const salt = Buffer.from(saltB64, "base64");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const key = deriveKey(getMasterKey(), salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
