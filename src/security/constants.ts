/** Current version tag stored alongside encrypted payloads for future migration. */
export const VAULT_VERSION = 1;

/** PBKDF2 iteration count. High enough for brute-force resistance. */
export const PBKDF2_ITERATIONS = 600_000;

/** AES-GCM key length in bits. */
export const AES_KEY_LENGTH = 256;

/** Salt length in bytes for PBKDF2 derivation. */
export const SALT_BYTE_LENGTH = 16;

/** IV length in bytes for AES-GCM encryption. */
export const IV_BYTE_LENGTH = 12;

/** Default inactivity timeout before auto-lock (5 minutes). */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * A fixed plaintext string encrypted during passphrase setup.
 * On unlock we decrypt the stored vault record and compare against this value
 * to verify the passphrase without ever persisting it.
 */
export const VAULT_VERIFIER_PLAINTEXT = "indexlens-vault-ok";

// ---------------------------------------------------------------------------
// chrome.storage.local key prefixes
// ---------------------------------------------------------------------------

/** Key for the encrypted vault verifier record. */
export const STORAGE_KEY_VAULT = "vault_verifier";

/** Prefix for per-credential encrypted records. */
export const STORAGE_KEY_CREDENTIAL_PREFIX = "cred_";

/** Key for the serialised timeout setting. */
export const STORAGE_KEY_TIMEOUT = "lock_timeout_ms";
