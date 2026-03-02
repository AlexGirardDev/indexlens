# IndexLens

A Chrome extension for viewing Elasticsearch data with encrypted credential storage.

## Development

### Prerequisites

- Node.js 20+
- npm

### Install & Build

```bash
npm install
npm run build
```

### Load in Chrome

1. Run `npm run build` to produce the `dist/` folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the `dist/` directory.
4. The extension registers a background service worker (`background.js`) and a full-page options UI (`index.html`).
5. Click the extension icon or navigate to the options page to open IndexLens.

### Development Server

```bash
npm run dev
```

> **Note:** The dev server is useful for iterating on UI, but `chrome.runtime` APIs (messaging, storage, ports) only work when loaded as an unpacked extension.

## Security Model

IndexLens encrypts all Elasticsearch credentials at rest using a passphrase-derived key. The passphrase itself is never stored.

### How It Works

1. **First-run setup** - The user creates a passphrase (minimum 8 characters). A PBKDF2-derived AES-256-GCM key is produced from the passphrase and a random salt. A known verifier string is encrypted and stored alongside the salt so future unlocks can validate the passphrase without persisting it.

2. **Unlocking** - On subsequent sessions the user enters their passphrase. The extension re-derives the key from the stored salt and attempts to decrypt the verifier. If decryption succeeds and the plaintext matches, the session is unlocked and the derived key is held in the service worker's memory.

3. **Credential storage** - Each credential is encrypted with AES-256-GCM using a unique random IV and stored in `chrome.storage.local`. Credentials can only be read, written, or deleted while the session is unlocked. All credential operations return an explicit "Locked" error when the session is locked.

4. **Idle auto-lock** - A configurable inactivity timeout (default: 5 minutes) automatically wipes the derived key and locks the session. The timeout resets only on meaningful user activity (key presses, mouse clicks, window focus) forwarded from the page over a long-lived port to the background worker.

5. **Keep-alive port** - The page maintains a persistent `chrome.runtime.Port` connection to the background. Activity signals travel over this port, and the background broadcasts lock-status changes back to the page for immediate UI updates.

### Key Design Decisions

- **WebCrypto only** - All cryptographic operations use the browser's native `crypto.subtle` API. No third-party crypto libraries.
- **PBKDF2 with 600,000 iterations** - Provides brute-force resistance for the passphrase derivation step.
- **AES-256-GCM** - Authenticated encryption ensures both confidentiality and integrity of stored credentials.
- **In-memory key** - The derived `CryptoKey` lives only in the service worker's memory and is cleared on lock. It is never serialised or written to storage.
- **Versioned payloads** - Every encrypted envelope carries a version tag for future migration support.

## Manual Verification Checklist

### First-Run Setup
- [ ] Open the extension for the first time and see the "Welcome to IndexLens" setup screen.
- [ ] Attempt to submit a passphrase shorter than 8 characters and confirm validation prevents it.
- [ ] Enter a valid passphrase, intentionally mismatch the confirmation, and verify the error.
- [ ] Enter a valid passphrase with matching confirmation, click "Create passphrase", and confirm you are taken to the unlocked view.

### Unlock Persistence During Active Use
- [ ] Close and reopen the extension tab. Confirm you see the lock screen (not setup).
- [ ] Enter the correct passphrase and verify unlock succeeds.
- [ ] Interact with the page (click, type) and confirm the session stays unlocked beyond the 5-minute timeout window.
- [ ] Enter an incorrect passphrase and verify an error is shown.

### Automatic Re-Lock After Idle
- [ ] Unlock the extension and leave it idle (no mouse/keyboard activity) for longer than 5 minutes.
- [ ] Confirm the UI transitions back to the lock screen automatically.
- [ ] Verify you can unlock again with the correct passphrase.

## Project Structure

```
src/
  extension/
    background.ts   - Service worker: lock state, messaging, idle timer
    types.ts        - Typed message contracts (page <-> background)
  security/
    constants.ts    - Crypto & storage constants, default timeout
    crypto.ts       - WebCrypto primitives (PBKDF2, AES-GCM)
    storage.ts      - chrome.storage.local wrapper
  page/
    lock-state.ts   - Page-side state types, passphrase validation
    use-lock-session.ts - React hook for lock lifecycle & activity heartbeat
    setup-screen.tsx    - First-run passphrase creation UI
    lock-screen.tsx     - Locked passphrase entry UI
    unlocked-shell.tsx  - Unlocked application shell
  App.tsx           - Root component routing between lock states
  main.tsx          - React entry point
```
