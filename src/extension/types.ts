/**
 * Typed message contracts for page-to-background communication.
 *
 * Every runtime message is a discriminated union keyed on `type`.
 * Responses are mapped via MessageResponseMap so both sides share the contract.
 */

// ---------------------------------------------------------------------------
// Lock / session status
// ---------------------------------------------------------------------------

export type LockStatus = "first_run" | "locked" | "unlocked";

export interface SessionStatus {
  lockStatus: LockStatus;
  timeoutMs: number;
  lastActivity: number;
}

// ---------------------------------------------------------------------------
// Request messages  (page → background)
// ---------------------------------------------------------------------------

export interface GetStatusMessage {
  type: "GET_STATUS";
}

export interface SetupPassphraseMessage {
  type: "SETUP_PASSPHRASE";
  passphrase: string;
}

export interface UnlockMessage {
  type: "UNLOCK";
  passphrase: string;
}

export interface LockMessage {
  type: "LOCK";
}

export interface SaveCredentialMessage {
  type: "SAVE_CREDENTIAL";
  id: string;
  plaintext: string;
}

export interface ReadCredentialMessage {
  type: "READ_CREDENTIAL";
  id: string;
}

export interface DeleteCredentialMessage {
  type: "DELETE_CREDENTIAL";
  id: string;
}

export type RuntimeMessage =
  | GetStatusMessage
  | SetupPassphraseMessage
  | UnlockMessage
  | LockMessage
  | SaveCredentialMessage
  | ReadCredentialMessage
  | DeleteCredentialMessage;

// ---------------------------------------------------------------------------
// Response types  (background → page)
// ---------------------------------------------------------------------------

export interface SuccessResponse<T = void> {
  ok: true;
  data: T;
}

export interface ErrorResponse {
  ok: false;
  error: string;
}

export type Result<T = void> = SuccessResponse<T> | ErrorResponse;

export interface MessageResponseMap {
  GET_STATUS: Result<SessionStatus>;
  SETUP_PASSPHRASE: Result;
  UNLOCK: Result;
  LOCK: Result;
  SAVE_CREDENTIAL: Result;
  READ_CREDENTIAL: Result<string>;
  DELETE_CREDENTIAL: Result;
}

// ---------------------------------------------------------------------------
// Port keep-alive
// ---------------------------------------------------------------------------

/** Name used for the long-lived port connection. */
export const KEEPALIVE_PORT_NAME = "indexlens-keepalive";

export interface PortActivityMessage {
  type: "ACTIVITY";
}

/** Sent from background → page over the port when lock status changes. */
export interface PortStatusMessage {
  type: "STATUS_CHANGED";
  lockStatus: LockStatus;
}

/** Union of all messages that can flow over the keep-alive port. */
export type PortMessage = PortActivityMessage | PortStatusMessage;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function ok(): Result;
export function ok<T>(data: T): Result<T>;
export function ok<T>(data?: T): Result<T> {
  return { ok: true, data: data as T };
}

export function err(error: string): ErrorResponse {
  return { ok: false, error };
}
