"use client";

// The first screen anyone sees.
//
// It used to sit on #faf7f0 - a cream that appears in no token and nowhere
// else in the product - with grey labels and a flat green button, so the thing
// that introduced DRM looked like it belonged to a different application than
// DRM. It now uses the same surfaces, type and controls as every screen behind
// it.

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { homeFor, useAuth } from "@/lib/auth-context";
import { Alert, Button, Field, Input } from "@/components/ui";
import { BrandMark } from "@/components/brand-mark";

export default function LoginPage() {
  const { login, user, ready } = useAuth();
  const router = useRouter();

  // Already signed in - opening the app, or DRM's address with a login still
  // stored: straight on to work instead of asking for the password again.
  useEffect(() => {
    if (ready && user) router.replace(homeFor(user.role));
  }, [ready, user, router]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in. Try again.");
    } finally {
      setLoading(false);
    }
  };

  // Checking who is signed in, or on the way in: no form to flash past.
  if (!ready || user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page px-4">
        <p className="text-sm text-ink-muted">Opening DRM…</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-page px-4 py-10">
      {/* Two very soft washes behind the card. The page plane is a flat pale
          blue, and a single white card centred on it reads as an unfinished
          page rather than as a considered one; this gives the background
          somewhere to go without putting anything in front of the form. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-200/35 blur-3xl"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-brand-100/50 blur-3xl"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 text-center">
          <span className="mx-auto mb-4 block w-fit">
            <BrandMark className="h-14 w-14 shadow-raised" rounded="rounded-panel" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">HKM Vizag</h1>
          <p className="mt-1 text-sm text-ink-muted">Donor manager</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-panel border border-line-soft bg-surface p-6 shadow-raised sm:p-7"
        >
          {error && <Alert tone="danger">{error}</Alert>}

          <Field label="E-mail ID" htmlFor="login-email" required>
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="admin@hkmvizag.org"
              invalid={!!error}
            />
          </Field>

          <Field label="Password" htmlFor="login-password" required>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              invalid={!!error}
            />
          </Field>

          <Button type="submit" size="lg" block loading={loading} className="mt-1">
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-ink-faint">
          Hare Krishna Movement, Visakhapatnam
        </p>
      </div>
    </div>
  );
}
