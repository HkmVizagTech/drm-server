"use client";

// Handing a devotee's receipt to the donor, from the devotee's own phone.
//
// No WhatsApp is sent automatically for these receipts; the devotee sends it:
//   - WhatsApp: in the DRM Android app (1.0.6+), WhatsApp opens on the donor's own chat with the
//     receipt PDF attached and the thank-you as its caption - the devotee presses Send. In a
//     browser, WhatsApp's chat links carry text only, so the donor's chat opens with the thank-you
//     and a link to their receipt PDF (an unguessable one: see server/src/routes/receiptLink.ts).
//   - Share PDF: on phones that can share files, the PDF itself through the phone's share sheet;
//     the devotee picks the donor's chat in WhatsApp.
//   - Download: the PDF, to keep or print.

import { useState, useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api";
import { currency } from "@/lib/format";
import { whatsappHref } from "@/lib/devotee";
import { phone } from "@/lib/phone-app";
import { Button, buttonClass } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";

export interface ShareableReceipt {
  id: string;
  donor_name: string;
  donor_mobile: string;
  amount: number;
  seva_name: string | null;
  receipt_number: string | null;
  share_token: string | null;
}

export const receiptLink = (token: string) => `${window.location.origin}/api/receipt-link/${token}`;

/** The thank-you that goes with the receipt, in the temple's words. */
export function receiptMessage(r: ShareableReceipt): string {
  const first = r.donor_name.trim().split(/\s+/)[0] || r.donor_name;
  return [
    `Hare Krishna ${first}!`,
    "",
    `Thank you for your donation of ${currency(r.amount)}${r.seva_name ? ` towards ${r.seva_name}` : ""}.`,
    r.receipt_number ? `Receipt No. ${r.receipt_number}` : null,
    r.share_token ? `\nYour receipt: ${receiptLink(r.share_token)}` : null,
    "",
    "Hare Krishna Movement, Visakhapatnam",
  ]
    .filter((x) => x !== null)
    .join("\n");
}

async function receiptFile(r: ShareableReceipt): Promise<File> {
  const blob = await apiClient.getBlob(`/api/devotee/receipts/${r.id}/file`);
  const name = `receipt-${(r.receipt_number ?? r.id).replace(/[^a-zA-Z0-9-]/g, "-")}.pdf`;
  return new File([blob], name, { type: "application/pdf" });
}

/** Can this browser share a PDF through the phone's share sheet? (Read once; it does not change.) */
function canShareFiles(): boolean {
  try {
    return typeof navigator !== "undefined" && !!navigator.canShare?.({ files: [new File([""], "r.pdf", { type: "application/pdf" })] });
  } catch {
    return false;
  }
}
const noSubscribe = () => () => {};

export function ReceiptActions({ r, compact = false }: { r: ShareableReceipt; compact?: boolean }) {
  const [busy, setBusy] = useState<"pdf" | "share" | "wa" | null>(null);
  const shareable = useSyncExternalStore(noSubscribe, canShareFiles, () => false);
  const size = compact ? "xs" : "sm";

  async function download() {
    setBusy("pdf");
    try {
      const file = await receiptFile(r);
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error("Could not get the receipt", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  /** In the app: the PDF attached on the donor's chat. Anywhere else, or if that fails: the chat link. */
  async function whatsApp(e: React.MouseEvent<HTMLAnchorElement>) {
    const app = phone();
    if (!app?.shareToWhatsApp) return; // a browser, or an older app: the link opens as usual
    e.preventDefault();
    const href = e.currentTarget.href;
    setBusy("wa");
    try {
      const file = await receiptFile(r);
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await app.shareToWhatsApp({ phone: r.donor_mobile, text: receiptMessage({ ...r, share_token: null }), fileName: file.name, base64: btoa(bin) });
    } catch {
      window.open(href, "_blank", "noopener");
    } finally {
      setBusy(null);
    }
  }

  async function sharePdf() {
    setBusy("share");
    try {
      const file = await receiptFile(r);
      await navigator.share({ files: [file], text: receiptMessage({ ...r, share_token: null }) });
    } catch (e) {
      // Closing the share sheet is not a failure.
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        toast.error("Could not share the receipt", e instanceof Error ? e.message : undefined);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <a
        href={whatsappHref(r.donor_mobile, receiptMessage(r))}
        target="_blank"
        rel="noreferrer"
        className={buttonClass("whatsapp", size)}
        title={`Send to ${r.donor_name} on WhatsApp`}
        onClick={(e) => void whatsApp(e)}
        aria-busy={busy === "wa" || undefined}
      >
        <Icon name="message" size={compact ? 13 : 15} />
        {busy === "wa" ? "Opening…" : "WhatsApp"}
      </a>
      <Button size={size} variant="secondary" icon="download" loading={busy === "pdf"} onClick={() => void download()}>
        {compact ? "PDF" : "Download"}
      </Button>
      {shareable && (
        <Button size={size} variant="ghost" icon="externalLink" loading={busy === "share"} onClick={() => void sharePdf()}>
          Share PDF
        </Button>
      )}
    </div>
  );
}
