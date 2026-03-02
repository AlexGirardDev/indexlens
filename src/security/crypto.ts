/**
 * WebCrypto primitives for passphrase-based key derivation and
 * AES-GCM encryption / decryption.
 *
 * Design:
 * - A single PBKDF2 salt is generated at passphrase setup and stored
 *   with the vault verifier.  The same salt is used on every unlock
 *   to re-derive the same AES-GCM key.
 * - Each encrypted payload carries a unique random IV, which is
 *   sufficient for AES-GCM semantic security with a fixed key.
 * - The EncryptedPayload envelope includes a version tag for future
 *   migration.
 */

import {
  VAULT_VERSION,
  PBKDF2_ITERATIONS,
  AES_KEY_LENGTH,
  SALT_BYTE_LENGTH,
  IV_BYTE_LENGTH,
} from "./constants";

// ---------------------------------------------------------------------------
// Encrypted payload envelope
// ---------------------------------------------------------------------------

/** Serialisable envelope stored in chrome.storage.local. */
export interface EncryptedPayload {
  /** Schema version for future migration. */
  v: number;
  /** Base-64 encoded random IV used for AES-GCM. */
  iv: string;
  /** Base-64 encoded ciphertext (AES-GCM output). */
  data: string;
}

/** Salt + encrypted verifier stored once during setup. */
export interface VaultRecord {
  /** Schema version. */
  v: number;
  /** Base-64 encoded PBKDF2 salt. */
  salt: string;
  /** Encrypted verifier payload. */
  verifier: EncryptedPayload;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const buf = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/** Generate a fresh random salt. */
export function generateSalt(): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTE_LENGTH));
}

/** Encode a salt to base-64 for storage. */
export function encodeSalt(salt: Uint8Array<ArrayBuffer>): string {
  return toBase64(salt);
}

/** Decode a base-64 salt back to bytes. */
export function decodeSalt(b64: string): Uint8Array<ArrayBuffer> {
  return fromBase64(b64);
}

/**
 * Derive an AES-GCM CryptoKey from a passphrase and salt via PBKDF2.
 */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt a plaintext string into an {@link EncryptedPayload}.
 * A fresh random IV is generated for every call.
 */
export async function encryptPayload(
  key: CryptoKey,
  plaintext: string,
): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoder.encode(plaintext) as BufferSource,
  );

  return {
    v: VAULT_VERSION,
    iv: toBase64(iv),
    data: toBase64(ciphertext),
  };
}

/**
 * Decrypt an {@link EncryptedPayload} back to plaintext.
 * Throws if the key is wrong or data is corrupt.
 */
export async function decryptPayload(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<string> {
  const iv = fromBase64(payload.iv);
  const ciphertext = fromBase64(payload.data);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ciphertext as BufferSource,
  );

  return decoder.decode(plainBuffer);
}

/**
 * Zero-fill a Uint8Array to clear sensitive material from memory.
 */
export function clearBuffer(buf: Uint8Array<ArrayBuffer>): void {
  buf.fill(0);
}
