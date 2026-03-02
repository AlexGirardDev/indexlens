/**
 * Background service worker for the IndexLens Chrome extension.
 *
 * Owns the authoritative lock state and session lifecycle.
 * Communicates with the full-page UI via chrome.runtime messaging and
 * a long-lived port for keep-alive / activity tracking.
 */

import type {
  RuntimeMessage,
  MessageResponseMap,
  PortMessage,
  SessionStatus,
  LockStatus,
} from "./types";
import { KEEPALIVE_PORT_NAME, ok, err } from "./types";

import {
  isPassphraseInitialised,
  loadTimeoutMs,
  storeTimeoutMs,
  storeVaultRecord,
  loadVaultRecord,
  loadEncryptedCredential,
  storeEncryptedCredential,
  deleteEncryptedCredential,
} from "../security/storage";
import {
  deriveKey,
  encryptPayload,
  decryptPayload,
  generateSalt,
  encodeSalt,
  decodeSalt,
} from "../security/crypto";
import type { VaultRecord } from "../security/crypto";
import {
  DEFAULT_TIMEOUT_MS,
  VAULT_VERIFIER_PLAINTEXT,
  VAULT_VERSION,
} from "../security/constants";

// ---------------------------------------------------------------------------
// Session state (in-memory only — never persisted in plaintext)
// ---------------------------------------------------------------------------

let lockStatus: LockStatus = "first_run";
let derivedKey: CryptoKey | null = null;
let lastActivity: number = Date.now();
let timeoutMs: number = DEFAULT_TIMEOUT_MS;
let idleInterval: ReturnType<typeof setInterval> | null = null;

/** Connected keep-alive ports for broadcasting status changes. */
const connectedPorts = new Set<chrome.runtime.Port>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionStatus(): SessionStatus {
  return { lockStatus, timeoutMs, lastActivity };
}

function touchActivity(): void {
  lastActivity = Date.now();
}

/** Send a status update to all connected pages. */
function broadcastStatus(): void {
  const msg: PortMessage = { type: "STATUS_CHANGED", lockStatus };
  for (const port of connectedPorts) {
    try {
      port.postMessage(msg);
    } catch {
      connectedPorts.delete(port);
    }
  }
}

function lockNow(): void {
  derivedKey = null;
  lockStatus = "locked";
  if (idleInterval !== null) {
    clearInterval(idleInterval);
    idleInterval = null;
  }
  broadcastStatus();
}

function startIdleTimer(): void {
  if (idleInterval !== null) clearInterval(idleInterval);
  idleInterval = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      lockNow();
    }
  }, 15_000); // check every 15 s
}

// ---------------------------------------------------------------------------
// Initialise state on worker start
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  const initialised = await isPassphraseInitialised();
  lockStatus = initialised ? "locked" : "first_run";
  timeoutMs = (await loadTimeoutMs()) ?? DEFAULT_TIMEOUT_MS;
}

init();

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

type MessageType = RuntimeMessage["type"];

async function handleMessage<T extends MessageType>(
  msg: RuntimeMessage & { type: T },
): Promise<MessageResponseMap[T]> {
  touchActivity();

  switch (msg.type) {
    case "GET_STATUS": {
      return ok(getSessionStatus()) as MessageResponseMap[T];
    }

    case "SETUP_PASSPHRASE": {
      if (lockStatus !== "first_run") {
        return err("Passphrase already configured") as MessageResponseMap[T];
      }
      const setupMsg = msg as Extract<RuntimeMessage, { type: "SETUP_PASSPHRASE" }>;
      try {
        const salt = generateSalt();
        const key = await deriveKey(setupMsg.passphrase, salt);

        // Encrypt a known verifier so we can validate on future unlocks
        const verifier = await encryptPayload(key, VAULT_VERIFIER_PLAINTEXT);
        const vaultRecord: VaultRecord = {
          v: VAULT_VERSION,
          salt: encodeSalt(salt),
          verifier,
        };
        await storeVaultRecord(vaultRecord);
        await storeTimeoutMs(timeoutMs);

        derivedKey = key;
        lockStatus = "unlocked";
        startIdleTimer();
        return ok() as MessageResponseMap[T];
      } catch (e) {
        return err(
          e instanceof Error ? e.message : "Setup failed",
        ) as MessageResponseMap[T];
      }
    }

    case "UNLOCK": {
      if (lockStatus === "first_run") {
        return err("Passphrase not set up yet") as MessageResponseMap[T];
      }
      if (lockStatus === "unlocked") {
        return ok() as MessageResponseMap[T];
      }
      const unlockMsg = msg as Extract<RuntimeMessage, { type: "UNLOCK" }>;
      try {
        const vaultRecord = await loadVaultRecord();
        if (!vaultRecord) {
          return err("Vault data missing") as MessageResponseMap[T];
        }
        const salt = decodeSalt(vaultRecord.salt);
        const key = await deriveKey(unlockMsg.passphrase, salt);
        const plaintext = await decryptPayload(key, vaultRecord.verifier);
        if (plaintext !== VAULT_VERIFIER_PLAINTEXT) {
          return err("Invalid passphrase") as MessageResponseMap[T];
        }
        derivedKey = key;
        lockStatus = "unlocked";
        startIdleTimer();
        return ok() as MessageResponseMap[T];
      } catch {
        return err("Invalid passphrase") as MessageResponseMap[T];
      }
    }

    case "LOCK": {
      lockNow();
      return ok() as MessageResponseMap[T];
    }

    case "SAVE_CREDENTIAL": {
      if (lockStatus !== "unlocked" || !derivedKey) {
        return err("Locked") as MessageResponseMap[T];
      }
      const saveMsg = msg as Extract<RuntimeMessage, { type: "SAVE_CREDENTIAL" }>;
      try {
        const encrypted = await encryptPayload(derivedKey, saveMsg.plaintext);
        await storeEncryptedCredential(saveMsg.id, encrypted);
        return ok() as MessageResponseMap[T];
      } catch (e) {
        return err(
          e instanceof Error ? e.message : "Encrypt failed",
        ) as MessageResponseMap[T];
      }
    }

    case "READ_CREDENTIAL": {
      if (lockStatus !== "unlocked" || !derivedKey) {
        return err("Locked") as MessageResponseMap[T];
      }
      const readMsg = msg as Extract<RuntimeMessage, { type: "READ_CREDENTIAL" }>;
      try {
        const encrypted = await loadEncryptedCredential(readMsg.id);
        if (!encrypted) {
          return err("Credential not found") as MessageResponseMap[T];
        }
        const plaintext = await decryptPayload(derivedKey, encrypted);
        return ok(plaintext) as MessageResponseMap[T];
      } catch (e) {
        return err(
          e instanceof Error ? e.message : "Decrypt failed",
        ) as MessageResponseMap[T];
      }
    }

    case "DELETE_CREDENTIAL": {
      if (lockStatus !== "unlocked" || !derivedKey) {
        return err("Locked") as MessageResponseMap[T];
      }
      const delMsg = msg as Extract<RuntimeMessage, { type: "DELETE_CREDENTIAL" }>;
      try {
        await deleteEncryptedCredential(delMsg.id);
        return ok() as MessageResponseMap[T];
      } catch (e) {
        return err(
          e instanceof Error ? e.message : "Delete failed",
        ) as MessageResponseMap[T];
      }
    }

    default: {
      return err("Unknown message type") as MessageResponseMap[T];
    }
  }
}

// ---------------------------------------------------------------------------
// chrome.runtime listeners
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: MessageResponseMap[RuntimeMessage["type"]]) => void,
  ) => {
    handleMessage(message).then(sendResponse);
    return true; // keep the message channel open for async response
  },
);

// ---------------------------------------------------------------------------
// Keep-alive port for activity tracking
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== KEEPALIVE_PORT_NAME) return;

  connectedPorts.add(port);
  touchActivity();

  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.type === "ACTIVITY") {
      touchActivity();
    }
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
  });
});
