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
import { Alert, Button, Field, Input, Select } from "./ui";

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
  const [sent, setSent] = useState<{ label: string; at: number; copied: boolean } | null>(null);

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

  /** The fallback when the clipboard is unavailable: save it and attach by hand. */
  async function downloadImage(qrRowId: string) {
    try {
      const res = await fetch(`/api/crm/qrs/${qrRowId}/image.png`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` },
      });
      if (!res.ok) throw new Error("Could not fetch the image");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `qr-${qrRowId}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download that image");
    }
  }

  if (!qrs.length) return null;

  const current = qrs.find((q) => q.id === chosen) ?? null;

  /**
   * Put the QR picture on the clipboard.
   *
   * WHY THE CALLER HAS TO PASTE
   * WhatsApp's click-to-chat link carries text and nothing else - there is no
   * way to attach a picture to it. The only ways to put an actual image in a
   * chat are the Business API (a paid message per send) or a human pressing
   * paste. This is the second.
   *
   * PNG via a canvas, because the clipboard is only dependable with PNG: a
   * JPEG written directly is rejected by some browsers and the copy silently
   * does nothing, which looks exactly like a broken button.
   */
  async function copyImage(qrRowId: string): Promise<boolean> {
    try {
      if (!navigator.clipboard || typeof ClipboardItem === "undefined") return false;
      // Served by DRM rather than fetched from R2 or Razorpay: reading pixels
      // out of a cross-origin image is blocked, and neither of those origins
      // is ours to add CORS headers to.
      const res = await fetch(`/api/crm/qrs/${qrRowId}/image.png`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` },
      });
      if (!res.ok) return false;
      const blob = await res.blob();

      const png =
        blob.type === "image/png"
          ? blob
          : await new Promise<Blob | null>((resolve) => {
              const img = new Image();
              const url = URL.createObjectURL(blob);
              img.onload = () => {
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                c.getContext("2d")?.drawImage(img, 0, 0);
                URL.revokeObjectURL(url);
                c.toBlob(resolve, "image/png");
              };
              img.onerror = () => {
                URL.revokeObjectURL(url);
                resolve(null);
              };
              img.src = url;
            });

      if (!png) return false;
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return true;
    } catch {
      // Blocked, unsupported, or the tab lost focus mid-copy. The caller still
      // gets the chat and the message; they just attach the picture the way
      // they do today.
      return false;
    }
  }

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

      // Copy BEFORE opening WhatsApp. The clipboard API needs the document
      // focused, and window.open takes focus away - do it the other way round
      // and the copy fails every time.
      const copied = await copyImage(chosen);

      // Opened after the record is written, so a payment always has a share to
      // match even if the caller closes DRM the moment WhatsApp appears.
      window.open(r.wa_url, "_blank", "noopener,noreferrer");
      setSent({ label: r.qr.label, at: Date.now(), copied });
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
        {/* Field rather than a <label> wrapped around the control: Select is a
            button plus a listbox, and a label wrapping a button makes clicking
            the word "Send a QR" open the list, which is not what the caller
            was aiming at. The name reaches the control through ariaLabel. */}
        <Field label="Send a QR" className="min-w-[12rem] flex-1">
          <Select
            value={chosen}
            onChange={setChosen}
            ariaLabel="Send a QR"
            className="w-full"
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
        </Field>

        {/* The shared Input, which borders on --line-strong. This box used to
            roll its own on --line, so the amount field sat a shade paler than
            every other field on the calling screen. */}
        <Field label="Amount" className="w-28" htmlFor="qr-amount">
          <Input
            id="qr-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>

        <Button
          variant="whatsapp"
          icon="qr"
          onClick={() => void share()}
          disabled={!chosen}
          loading={busy}
          data-send-qr
          title="Copies the QR picture and opens WhatsApp in this donor's chat"
        >
          Copy QR &amp; open chat
        </Button>
      </div>

      {current?.purpose && (
        <p className="mt-1.5 text-2xs text-ink-muted">
          {current.label} is for {current.purpose}
          {current.fixed_amount && ` · fixed at ${currency(Number(current.fixed_amount))}`}
        </p>
      )}

      {sent && (
        <Alert tone="good" className="mt-2">
          {sent.copied ? (
            <p>
              <strong>The QR picture is copied.</strong> In the WhatsApp window that just opened, press{" "}
              <kbd className="rounded-md border border-line-strong bg-surface px-1 font-mono">Ctrl</kbd>+
              <kbd className="rounded-md border border-line-strong bg-surface px-1 font-mono">V</kbd> to paste it,
              then send. The message is already in the box.
            </p>
          ) : (
            <p>
              {sent.label} opened in WhatsApp with the message ready. The picture could not be copied on this
              computer —{" "}
              <button
                type="button"
                onClick={() => void downloadImage(chosen)}
                className="font-medium underline underline-offset-2"
              >
                download the QR
              </button>{" "}
              and attach it.
            </p>
          )}
          <p className="mt-1">When they pay, it shows up against this lead on its own.</p>
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mt-2">
          {error}
        </Alert>
      )}
    </div>
  );
}
