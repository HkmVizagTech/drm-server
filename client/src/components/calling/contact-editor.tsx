"use client";

// Correcting who somebody is and how to reach them.
//
// WHY THIS LIVES ON THE CALL SCREEN, NOT ONLY ON THE LEAD PAGE
// The moment a caller learns the number is wrong ("this is his wife's phone,
// note his own") is mid-call, with the donor still talking. Sending them to the
// lead page to fix it means losing their place in the run, so in practice the
// right number went into the note box and the wrong one stayed on the lead -
// to be rung again tomorrow by somebody else.
//
// THE 409 IS AN ANSWER, NOT A FAILURE
// The server refuses a number that already belongs to another lead and says
// whose it is. The likely truth is that the two rows are one person entered
// twice, so the useful thing is a link to the other one - looked up through the
// same search the top bar uses, which means the link only appears when the
// caller is allowed to open that lead.

import { useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { Alert, Button, Field, Input, Modal } from "@/components/ui";
import { toast } from "@/components/toast";
import { formatPhone } from "@/lib/calling";

export interface ContactFields {
  id: string;
  name: string | null;
  phone: string;
  alt_phone: string | null;
}

const digits = (v: string) => v.replace(/\D/g, "").slice(-10);

export function ContactEditor({
  lead,
  onClose,
  onSaved,
}: {
  lead: ContactFields;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(lead.name ?? "");
  const [phone, setPhone] = useState(lead.phone);
  const [alt, setAlt] = useState(lead.alt_phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The other lead that already has this number, when the caller may open it.
  const [clash, setClash] = useState<{ id: string; name: string | null } | null>(null);

  async function save() {
    const body: Record<string, unknown> = {};
    if (name.trim() && name.trim() !== (lead.name ?? "")) body.name = name.trim();
    if (digits(phone) !== digits(lead.phone)) body.phone = phone;
    // Blank means "no other number" - sent as null so the server clears it,
    // rather than as an absent field it would leave alone.
    if (digits(alt) !== digits(lead.alt_phone ?? "")) body.alt_phone = alt.trim() ? alt : null;
    if (!Object.keys(body).length) return onClose();

    setBusy(true);
    setError(null);
    setClash(null);
    try {
      await apiClient.put(`/api/crm/leads/${lead.id}`, body);
      toast(body.phone ? `Number changed to ${formatPhone(digits(phone))}` : "Contact details saved");
      await onSaved();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save that";
      setError(message);
      if (/already has that number/i.test(message)) {
        // Best effort: the refusal itself is the important part.
        try {
          const want = digits(phone);
          const found = await apiClient.get<{ leads: { id: string; name: string | null; phone: string }[] }>(
            `/api/crm/search?q=${want}`
          );
          const other = found.leads.find((l) => l.phone === want && l.id !== lead.id);
          if (other) setClash({ id: other.id, name: other.name });
        } catch {
          /* no link, still the message */
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Name and numbers"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save()} disabled={digits(phone).length < 10}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Alert
          tone="danger"
          action={
            clash ? (
              <Link
                href={`/leads/${clash.id}`}
                className="whitespace-nowrap text-sm font-semibold text-brand-700 hover:underline"
              >
                Open {clash.name || "them"}
              </Link>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="contact-name" className="sm:col-span-2">
          <Input
            id="contact-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="As they said it"
            autoComplete="off"
          />
        </Field>
        <Field label="Mobile number" htmlFor="contact-phone" hint="10 digits. Changing it keeps all their history.">
          <Input
            id="contact-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            inputMode="tel"
            className="tabular-nums"
            invalid={!!error && /number/i.test(error)}
          />
        </Field>
        <Field label="Other number" htmlFor="contact-alt" hint="Leave blank to remove it.">
          <Input
            id="contact-alt"
            value={alt}
            onChange={(e) => setAlt(e.target.value.replace(/[^\d+\s-]/g, ""))}
            inputMode="tel"
            placeholder="Optional"
            className="tabular-nums"
          />
        </Field>
      </div>
    </Modal>
  );
}
