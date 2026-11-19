"use client";

// Devotee sign-in: the WhatsApp number, then the code sent to it on WhatsApp. No password. A number
// that is not on the devotee list gets a warning instead of a code. On success the devotee lands
// on their home in the devotee portal.
//
// Shown on the login page, which opens on it (e-mail sign-in is one link away). Just the card -
// the page around it is the login page's.

import { FormEvent, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { homeFor } from "@/lib/auth-context";
import { Alert, Button, Field, Input } from "@/components/ui";

const CARD = "space-y-4 rounded-panel border border-line-soft bg-surface p-6 shadow-raised sm:p-7";

export function DevoteeSignIn() {
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notListed, setNotListed] = useState(false);
  const [notice, setNotice] = useState("");
  const [wait, setWait] = useState(0);

  // The "send again" countdown.
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);

  const digits = phone.replace(/\D/g, "").slice(-10);

  async function sendCode(e?: FormEvent) {
    e?.preventDefault();
    setError("");
    setNotListed(false);
    setNotice("");
    if (digits.length !== 10) return setError("Enter your 10-digit WhatsApp number.");
    setBusy(true);
    try {
      const r = await apiClient.post<{ message?: string }>("/api/devotee-auth/otp", { phone: digits });
      setNotice(r.message ?? "A code has been sent to your WhatsApp.");
      setStep("otp");
      setOtp("");
      setWait(60);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not send the code. Try again.";
      if (/not on the devotee list/i.test(msg)) setNotListed(true);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!otp.trim()) return setError("Type the code from WhatsApp.");
    setBusy(true);
    try {
      const r = await apiClient.post<{ token: string }>("/api/devotee-auth/verify", { phone: digits, otp: otp.trim() });
      localStorage.setItem("token", r.token);
      // A full load, so the app signs in afresh and opens the devotee's home.
      window.location.assign(homeFor("devotee"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in. Try again.");
      setBusy(false);
    }
  }

  if (step === "phone") {
    return (
      <form onSubmit={sendCode} className={CARD}>
        {notListed && <Alert tone="warn">This number is not on the devotee list. Please contact the temple office to be added.</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="WhatsApp number" htmlFor="dv-phone" required hint="We will send a code to this number on WhatsApp.">
          <Input
            id="dv-phone"
            inputMode="numeric"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s]/g, ""))}
            placeholder="10-digit number"
            invalid={!!error || notListed}
          />
        </Field>
        <Button type="submit" size="lg" block loading={busy}>
          {busy ? "Sending…" : "Send code"}
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} className={CARD}>
      {notice && <Alert tone="good">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Field label="Code from WhatsApp" htmlFor="dv-otp" required hint={`Sent to ${digits}`}>
        <Input
          id="dv-otp"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="6-digit code"
          invalid={!!error}
        />
      </Field>
      <Button type="submit" size="lg" block loading={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </Button>
      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          className="text-ink-muted hover:text-ink"
          onClick={() => {
            setStep("phone");
            setError("");
            setNotice("");
          }}
        >
          Change number
        </button>
        <button
          type="button"
          disabled={wait > 0 || busy}
          className="font-medium text-brand-700 hover:underline disabled:text-ink-faint disabled:no-underline"
          onClick={() => void sendCode()}
        >
          {wait > 0 ? `Send again in ${wait}s` : "Send again"}
        </button>
      </div>
    </form>
  );
}
