/**
 * Thin wrapper around chrome.storage.local for encrypted payloads
 * and non-secret metadata.
 *
 * Only encrypted data and configuration values are persisted here.
 * Raw passphrases and plaintext credentials are NEVER written to storage.
 */

import type { EncryptedPayload, VaultRecord } from "./crypto";
import {
  STORAGE_KEY_VAULT,
  STORAGE_KEY_CREDENTIAL_PREFIX,
  STORAGE_KEY_TIMEOUT,
} from "./constants";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

async function getItem<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function setItem<T>(key: string, value: T): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function removeItem(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

// ---------------------------------------------------------------------------
// Vault verifier (passphrase setup detection + unlock validation)
// ---------------------------------------------------------------------------

/** Returns true if a vault verifier has been stored (i.e. passphrase is set up). */
export async function isPassphraseInitialised(): Promise<boolean> {
  const vault = await getItem<VaultRecord>(STORAGE_KEY_VAULT);
  return vault !== undefined;
}

/** Persist the vault record (salt + encrypted verifier). */
export async function storeVaultRecord(record: VaultRecord): Promise<void> {
  await setItem(STORAGE_KEY_VAULT, record);
}

/** Load the vault record. Returns undefined if not yet set up. */
export async function loadVaultRecord(): Promise<VaultRecord | undefined> {
  return getItem<VaultRecord>(STORAGE_KEY_VAULT);
}

// ---------------------------------------------------------------------------
// Per-credential encrypted records
// ---------------------------------------------------------------------------

/** Persist an encrypted credential under a namespaced key. */
export async function storeEncryptedCredential(
  id: string,
  payload: EncryptedPayload,
): Promise<void> {
  await setItem(STORAGE_KEY_CREDENTIAL_PREFIX + id, payload);
}

/** Load an encrypted credential. Returns undefined if not found. */
export async function loadEncryptedCredential(
  id: string,
): Promise<EncryptedPayload | undefined> {
  return getItem<EncryptedPayload>(STORAGE_KEY_CREDENTIAL_PREFIX + id);
}

/** Delete an encrypted credential. */
export async function deleteEncryptedCredential(id: string): Promise<void> {
  await removeItem(STORAGE_KEY_CREDENTIAL_PREFIX + id);
}

// ---------------------------------------------------------------------------
// Timeout configuration
// ---------------------------------------------------------------------------

/** Persist the lock timeout value (milliseconds). */
export async function storeTimeoutMs(ms: number): Promise<void> {
  await setItem(STORAGE_KEY_TIMEOUT, ms);
}

/** Load the stored timeout value. Returns undefined if not set. */
export async function loadTimeoutMs(): Promise<number | undefined> {
  return getItem<number>(STORAGE_KEY_TIMEOUT);
}
