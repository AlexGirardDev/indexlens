import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { useLockSession } from "@/page/use-lock-session";
import { SetupScreen } from "@/page/setup-screen";
import { LockScreen } from "@/page/lock-screen";
import { UnlockedShell } from "@/page/unlocked-shell";

function App() {
  const session = useLockSession();
  const [transitionKey, setTransitionKey] = useState(0);

  const handleUnlocked = () => setTransitionKey((k) => k + 1);

  return (
    <TooltipProvider>
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        {session.status === null && <LoadingScreen />}

        {session.status === "first_run" && (
          <SetupScreen
            key={transitionKey}
            pending={session.pending}
            error={session.error}
            onSetup={async (passphrase) => {
              const ok = await session.setupPassphrase(passphrase);
              if (ok) handleUnlocked();
            }}
            onClearError={session.clearError}
          />
        )}

        {session.status === "locked" && (
          <LockScreen
            key={transitionKey}
            pending={session.pending}
            error={session.error}
            onUnlock={async (passphrase) => {
              const ok = await session.unlock(passphrase);
              if (ok) handleUnlocked();
            }}
            onClearError={session.clearError}
          />
        )}

        {session.status === "unlocked" && (
          <UnlockedShell key={transitionKey} onLock={session.lock} />
        )}
      </div>
      <Toaster />
    </TooltipProvider>
  );
}

function LoadingScreen() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted border-t-primary" />
      <p className="text-sm text-muted-foreground">Connecting...</p>
    </div>
  );
}

export default App;
