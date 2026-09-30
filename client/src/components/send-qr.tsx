"use client";

// Sharing a Razorpay QR during a call.
//
// WHY THIS IS SEPARATE FROM SendLink
// A link is a page to visit. A QR is money: it belongs to a caller, and the
// payment that follows has to find its way back to this lead. So sharing one
// writes a row - this QR, this number, this caller, this moment - and that row
// is what a payment is matched against afterwards. Without it, a QR donation
// arrives in Razorpay attached to nothing, which is the situation today.
//
// WHAT THE CALLER SEES, AND WHAT THEY DON'T
// They pick from their own QRs and the temple's shared ones. They never see
// anybody else's. The amount box is optional and exists only to make the later
// match more confident - a donor who says "I'll send five thousand" gives DRM
// something to recognise the payment by.
//
// The button opens WhatsApp and says so. DRM cannot know whether the caller
// actually pressed send there, so nothing here ever claims it was delivered.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency } from "@/lib/format";
import { Select } from "./ui";

interface Qr {
  id: string;
  qr_id: string;
  label: string;
  image_url: string | null;
  purpose: string | null;
  fixed_amount: string | null;
  owner_id: string | null;
  owner_name: string | null;
}

export function SendQr({
  leadId,
  leadName,
  expectedAmount,
  sessionId,
  onShared,
}: {
  leadId: string;
  leadName?: string | null;
  expectedAmount?: string | null;
  sessionId?: string | null;
  onShared?: () => void;
}) {
  const [qrs, setQrs] = useState<Qr[]>([]);
  const [chosen, setChosen] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ label: string; at: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ qrs: Qr[] }>("/api/crm/qrs");
      setQrs(d.qrs);
      if (d.qrs.length && !chosen) setChosen(d.qrs[0].id);
    } catch {
      // A caller with no QRs set up is the ordinary case on day one, not an
      // error worth a red box over a call in progress.
    }
    // `chosen` is deliberately not a dependency: re-running this on every
    // selection would fight the caller for control of the dropdown.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A fresh lead means a fresh conversation. Carrying the last donor's amount
  // over would be a quiet way to mis-record what this one promised.
  useEffect(() => {
    setAmount(expectedAmount ? String(Math.round(Number(expectedAmount))) : "");
    setSent(null);
    setError(null);
  }, [leadId, expectedAmount]);

  if (!qrs.length) return null;

  const current = qrs.find((q) => q.id === chosen) ?? null;

  async function share() {
    if (!chosen || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ wa_url: string; qr: { label: string } }>(
        `/api/crm/leads/${leadId}/share-qr`,
        {
          qr_id: chosen,
          expected_amount: amount ? Number(amount) : undefined,
          session_id: sessionId ?? undefined,
        }
      );
      // Opened after the record is written, so a payment always has a share to
      // match even if the caller closes DRM the moment WhatsApp appears.
      window.open(r.wa_url, "_blank", "noopener,noreferrer");
      setSent({ label: r.qr.label, at: Date.now() });
      onShared?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not share that QR");
    } finally {
      setBusy(false);
    }
  }

  const mine = qrs.filter((q) => q.owner_id);
  const shared = qrs.filter((q) => !q.owner_id);

  return (
    <div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1 text-xs text-slate-500">
          Send a QR
          <Select
            value={chosen}
            onChange={setChosen}
            className="mt-1 w-full"
            options={[
              // A group on each option, which is how Select renders headings.
              ...mine.map((q) => ({
                value: q.id,
                label: q.label,
                group: "Your QR codes",
                hint: q.purpose ?? undefined,
              })),
              ...shared.map((q) => ({
                value: q.id,
                label: q.label,
                group: "The temple's",
                hint: q.purpose ?? undefined,
              })),
            ]}
          />
        </label>

        <label className="w-28 text-xs text-slate-500">
          Amount
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="mt-1 w-full rounded-lg border border-[var(--line)] px-3 py-2 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
        </label>

        <button
          type="button"
          onClick={() => void share()}
          disabled={busy || !chosen}
          data-send-qr
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#25D366] px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
            <path d="M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM13 13h2v2h-2zM17 13h2v2h-2zM15 15h2v2h-2zM13 17h2v2h-2zM17 17h2v2h-2zM19 15h2v2h-2zM19 19h2v2h-2z" />
          </svg>
          {busy ? "…" : "Send QR"}
        </button>
      </div>

      {current?.purpose && (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {current.label} is for {current.purpose}
          {current.fixed_amount && ` · fixed at ${currency(Number(current.fixed_amount))}`}
        </p>
      )}

      {sent && (
        <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          {sent.label} opened in WhatsApp for {leadName || "this donor"}. When they pay, it will show up against
          this lead on its own.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
