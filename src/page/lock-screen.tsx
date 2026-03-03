import { useState, type FormEvent } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface LockScreenProps {
  pending: boolean;
  error: string | null;
  onUnlock: (passphrase: string) => Promise<void>;
  onClearError: () => void;
}

export function LockScreen({
  pending,
  error,
  onUnlock,
  onClearError,
}: LockScreenProps) {
  const [passphrase, setPassphrase] = useState("");

  const canSubmit = !pending && passphrase.length > 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onUnlock(passphrase);
  };

  return (
    <Card className="w-full max-w-md mx-4">
      <CardHeader>
        <CardTitle className="text-xl">IndexLens is locked</CardTitle>
        <CardDescription>
          Enter your passphrase to unlock and access your Elasticsearch
          clusters.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="passphrase" className="text-sm font-medium">
              Passphrase
            </label>
            <Input
              id="passphrase"
              type="password"
              placeholder="Enter your passphrase"
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                if (error) onClearError();
              }}
              aria-invalid={!!error}
              disabled={pending}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {pending ? "Unlocking..." : "Unlock"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
