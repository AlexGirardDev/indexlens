/**
 * Page-side lock state model.
 *
 * Mirrors the background lock status but adds UI-specific concerns
 * (loading, error messages, pending states).
 */

import type { LockStatus } from "@/extension/types";

// ---------------------------------------------------------------------------
// App-level state
// ---------------------------------------------------------------------------

export interface LockState {
  /** Current lock status from background. `null` while loading initial status. */
  status: LockStatus | null;
  /** Whether an async operation (setup / unlock / lock) is in flight. */
  pending: boolean;
  /** Last error message from a failed operation, or null. */
  error: string | null;
}

export const INITIAL_LOCK_STATE: LockState = {
  status: null,
  pending: false,
  error: null,
};

// ---------------------------------------------------------------------------
// Passphrase validation policy
// ---------------------------------------------------------------------------

export const PASSPHRASE_MIN_LENGTH = 8;

export interface PassphraseValidation {
  valid: boolean;
  message: string | null;
}

export function validatePassphrase(passphrase: string): PassphraseValidation {
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) {
    return {
      valid: false,
      message: `Passphrase must be at least ${PASSPHRASE_MIN_LENGTH} characters`,
    };
  }
  return { valid: true, message: null };
}

export function validateConfirmation(
  passphrase: string,
  confirmation: string,
): PassphraseValidation {
  if (confirmation.length === 0) {
    return { valid: false, message: null };
  }
  if (passphrase !== confirmation) {
    return { valid: false, message: "Passphrases do not match" };
  }
  return { valid: true, message: null };
}
