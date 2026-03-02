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
import {
  PASSPHRASE_MIN_LENGTH,
  validatePassphrase,
  validateConfirmation,
} from "./lock-state";

interface SetupScreenProps {
  pending: boolean;
  error: string | null;
  onSetup: (passphrase: string) => Promise<void>;
  onClearError: () => void;
}

export function SetupScreen({
  pending,
  error,
  onSetup,
  onClearError,
}: SetupScreenProps) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [touched, setTouched] = useState({ passphrase: false, confirm: false });

  const ppValidation = touched.passphrase
    ? validatePassphrase(passphrase)
    : { valid: false, message: null };
  const cfValidation = touched.confirm
    ? validateConfirmation(passphrase, confirmation)
    : { valid: false, message: null };

  const canSubmit =
    !pending &&
    validatePassphrase(passphrase).valid &&
    validateConfirmation(passphrase, confirmation).valid;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSetup(passphrase);
  };

  return (
    <Card className="w-full max-w-md mx-4">
      <CardHeader>
        <CardTitle className="text-xl">Welcome to IndexLens</CardTitle>
        <CardDescription>
          Create a passphrase to encrypt your Elasticsearch credentials. You
          will need this passphrase to unlock the extension each session.
        </CardDescription>
      </CardHeader>

      <form onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="passphrase" className="text-sm font-medium">
              Passphrase
            </label>
            <Input
              id="passphrase"
              type="password"
              placeholder={`At least ${PASSPHRASE_MIN_LENGTH} characters`}
              autoFocus
              value={passphrase}
              onChange={(e) => {
                setPassphrase(e.target.value);
                if (error) onClearError();
              }}
              onBlur={() =>
                setTouched((t) => ({ ...t, passphrase: true }))
              }
              aria-invalid={touched.passphrase && !ppValidation.valid}
              disabled={pending}
            />
            {ppValidation.message && (
              <p className="text-xs text-destructive">{ppValidation.message}</p>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="confirm" className="text-sm font-medium">
              Confirm passphrase
            </label>
            <Input
              id="confirm"
              type="password"
              placeholder="Re-enter passphrase"
              value={confirmation}
              onChange={(e) => {
                setConfirmation(e.target.value);
                if (error) onClearError();
              }}
              onBlur={() =>
                setTouched((t) => ({ ...t, confirm: true }))
              }
              aria-invalid={touched.confirm && !cfValidation.valid}
              disabled={pending}
            />
            {cfValidation.message && (
              <p className="text-xs text-destructive">{cfValidation.message}</p>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>

        <CardFooter>
          <Button type="submit" className="w-full" disabled={!canSubmit}>
            {pending ? "Setting up..." : "Create passphrase"}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
