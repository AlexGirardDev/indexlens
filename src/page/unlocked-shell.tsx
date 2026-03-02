import { Button } from "@/components/ui/button";

interface UnlockedShellProps {
  onLock: () => Promise<void>;
}

export function UnlockedShell({ onLock }: UnlockedShellProps) {
  return (
    <div className="flex flex-col w-full min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <h1 className="text-lg font-semibold">IndexLens</h1>
        <Button variant="outline" size="sm" onClick={onLock}>
          Lock
        </Button>
      </header>

      <main className="flex-1 flex items-center justify-center p-6">
        <p className="text-muted-foreground">
          Unlocked. Elasticsearch viewer coming soon.
        </p>
      </main>
    </div>
  );
}
