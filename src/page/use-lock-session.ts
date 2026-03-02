/**
 * React hook that owns the page-side lock lifecycle.
 *
 * Responsibilities:
 * - Fetch initial lock status from the background on mount.
 * - Open a long-lived port for keep-alive / activity tracking.
 * - Forward user activity signals (focus, keydown, mousedown, clicks)
 *   as ACTIVITY pings over the port so the idle timer resets.
 * - Expose imperative helpers: setupPassphrase, unlock, lock.
 * - Poll for status changes so the UI re-locks when the background
 *   auto-locks due to idle timeout.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Result, SessionStatus, PortMessage } from "@/extension/types";
import { KEEPALIVE_PORT_NAME } from "@/extension/types";
import { INITIAL_LOCK_STATE } from "./lock-state";
import type { LockState } from "./lock-state";

// ---------------------------------------------------------------------------
// Helpers: chrome.runtime messaging
// ---------------------------------------------------------------------------

function sendMessage<T>(message: unknown): Promise<Result<T>> {
  return chrome.runtime.sendMessage(message) as Promise<Result<T>>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

const STATUS_POLL_INTERVAL_MS = 5_000;

export function useLockSession() {
  const [state, setState] = useState<LockState>(INITIAL_LOCK_STATE);
  const portRef = useRef<chrome.runtime.Port | null>(null);

  // -----------------------------------------------------------------------
  // Fetch status from background
  // -----------------------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      const res = await sendMessage<SessionStatus>({ type: "GET_STATUS" });
      if (res.ok) {
        setState((prev) => ({
          ...prev,
          status: res.data.lockStatus,
        }));
      }
    } catch {
      // Background may not be ready yet — silently retry on next poll
    }
  }, []);

  // -----------------------------------------------------------------------
  // Activity heartbeat over long-lived port
  // -----------------------------------------------------------------------

  const sendActivity = useCallback(() => {
    if (portRef.current) {
      try {
        portRef.current.postMessage({ type: "ACTIVITY" });
      } catch {
        // Port may have disconnected; reconnect will happen on next poll cycle
      }
    }
  }, []);

  // -----------------------------------------------------------------------
  // Setup port + activity listeners + polling on mount
  // -----------------------------------------------------------------------

  useEffect(() => {
    // Open the keep-alive port
    const port = chrome.runtime.connect(undefined, { name: KEEPALIVE_PORT_NAME });
    portRef.current = port;

    // Listen for status broadcasts from background (e.g. idle auto-lock)
    port.onMessage.addListener((msg: PortMessage) => {
      if (msg.type === "STATUS_CHANGED") {
        setState((prev) => ({ ...prev, status: msg.lockStatus }));
      }
    });

    port.onDisconnect.addListener(() => {
      portRef.current = null;
    });

    // Fetch initial status
    refreshStatus();

    // Poll for status changes (catches background idle auto-lock)
    const pollId = setInterval(refreshStatus, STATUS_POLL_INTERVAL_MS);

    // Activity event listeners — only meaningful user interaction
    const activityEvents = ["keydown", "mousedown", "focus"] as const;

    const handleActivity = () => sendActivity();

    for (const evt of activityEvents) {
      window.addEventListener(evt, handleActivity, { passive: true });
    }

    return () => {
      clearInterval(pollId);
      for (const evt of activityEvents) {
        window.removeEventListener(evt, handleActivity);
      }
      port.disconnect();
      portRef.current = null;
    };
  }, [refreshStatus, sendActivity]);

  // -----------------------------------------------------------------------
  // Imperative actions
  // -----------------------------------------------------------------------

  const setupPassphrase = useCallback(
    async (passphrase: string): Promise<boolean> => {
      setState((prev) => ({ ...prev, pending: true, error: null }));
      try {
        const res = await sendMessage({ type: "SETUP_PASSPHRASE", passphrase });
        if (res.ok) {
          setState({ status: "unlocked", pending: false, error: null });
          sendActivity();
          return true;
        }
        setState((prev) => ({
          ...prev,
          pending: false,
          error: res.error,
        }));
        return false;
      } catch (e) {
        setState((prev) => ({
          ...prev,
          pending: false,
          error: e instanceof Error ? e.message : "Setup failed",
        }));
        return false;
      }
    },
    [sendActivity],
  );

  const unlock = useCallback(
    async (passphrase: string): Promise<boolean> => {
      setState((prev) => ({ ...prev, pending: true, error: null }));
      try {
        const res = await sendMessage({ type: "UNLOCK", passphrase });
        if (res.ok) {
          setState({ status: "unlocked", pending: false, error: null });
          sendActivity();
          return true;
        }
        setState((prev) => ({
          ...prev,
          pending: false,
          error: res.error,
        }));
        return false;
      } catch (e) {
        setState((prev) => ({
          ...prev,
          pending: false,
          error: e instanceof Error ? e.message : "Unlock failed",
        }));
        return false;
      }
    },
    [sendActivity],
  );

  const lock = useCallback(async (): Promise<void> => {
    setState((prev) => ({ ...prev, pending: true, error: null }));
    try {
      await sendMessage({ type: "LOCK" });
      setState({ status: "locked", pending: false, error: null });
    } catch {
      setState((prev) => ({ ...prev, pending: false }));
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    setupPassphrase,
    unlock,
    lock,
    clearError,
  } as const;
}

// ---------------------------------------------------------------------------
// Credential helpers (gated by lock status)
// ---------------------------------------------------------------------------

export async function saveCredential(
  id: string,
  plaintext: string,
): Promise<Result> {
  return sendMessage({ type: "SAVE_CREDENTIAL", id, plaintext });
}

export async function readCredential(
  id: string,
): Promise<Result<string>> {
  return sendMessage<string>({ type: "READ_CREDENTIAL", id });
}

export async function deleteCredential(id: string): Promise<Result> {
  return sendMessage({ type: "DELETE_CREDENTIAL", id });
}
