"use client";

// Add record, for a devotee: the honoree's name (what is printed on the brick) and the donation
// receipt number are both required. The record joins the same list the team works from.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, shortDate } from "@/lib/format";
import { Alert, Badge, Button, EmptyState, Field, Input, Modal, Select, SegmentedControl, TableShell, Tbody, Td, Th, Thead } from "@/components/ui";
import { WHATSAPP_PATH, digitsOf, thanksMessage } from "@/components/seva-wall/wall-table";

type Kind = "brick" | "square" | "mandir";
interface Mine {
  ref: string;
  donor_name: string | null;
  honoree_name: string | null;
  phone: string | null;
  amount: number;
  receipt_number: string | null;
  kind: Kind;
  status: "to_print" | "needs_reprint" | "in_review" | "sent";
  created_at: string;
  has_image: boolean;
  uploaded_at: string | null;
  image_url: string | null;
  share_url: string | null;
}

const KIND_WORDS: Record<Kind, string> = { brick: "Brick seva", square: "Square foot seva", mandir: "Mandir nirmana seva" };

/** Where the brick stands, in the devotee's words. The picture comes only once a caller has approved it. */
function standing(r: Mine): { label: string; tone: "neutral" | "warn" | "good" | "info" } {
  if (r.status === "sent") return { label: "Approved - picture ready", tone: "good" };
  if (r.status === "in_review") return { label: "Printed - waiting for approval", tone: "info" };
  if (r.status === "needs_reprint") return { label: "Being printed again", tone: "warn" };
  return { label: "Waiting to be printed", tone: "neutral" };
}

/** The brick's picture, small; opens large in a window. Fetched with the login, which an <img src> cannot carry. */
function Thumb({ row }: { row: Mine }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    apiClient
      .getBlob(`/api/seva-wall/mine/${row.ref}/image`)
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [row.ref, row.uploaded_at]);

  if (failed) return <span className="text-xs text-ink-muted">Could not load</span>;
  if (!url) return <span className="inline-block h-14 w-14 animate-pulse rounded-control bg-sunken" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="View picture" className="block rounded-control">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Printed brick" className="h-14 w-14 rounded-control object-cover ring-1 ring-line-soft" />
      </button>
      {open && (
        <Modal title={`${row.honoree_name ?? row.donor_name ?? "Brick"} - ${KIND_WORDS[row.kind]}`} onClose={() => setOpen(false)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Printed brick" className="mx-auto max-h-[70vh] w-auto rounded-control" />
        </Modal>
      )}
    </>
  );
}

/** Opens the donor's WhatsApp chat with the thank-you and the picture's link already typed; the devotee presses Send. */
function WhatsAppLink({ row }: { row: Mine }) {
  const to = digitsOf(row.phone);
  if (!row.has_image || to.length < 10) return <span className="text-ink-faint">-</span>;
  const text = thanksMessage({ donor_name: row.donor_name, kind: row.kind, image_url: row.image_url, share_url: row.share_url });
  return (
    <a
      href={`https://wa.me/${to}?text=${encodeURIComponent(text)}`}
      target="_blank"
      rel="noreferrer"
      title={`Message ${row.donor_name ?? "the donor"} on WhatsApp`}
      aria-label={`Message ${row.donor_name ?? "the donor"} on WhatsApp`}
      className="inline-grid h-9 w-9 place-items-center rounded-control text-[#25D366] ring-1 ring-inset ring-line-soft transition-colors hover:bg-[#25D366]/10"
    >
      <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
        <path d={WHATSAPP_PATH} />
      </svg>
    </a>
  );
}

const EMPTY = { donor_name: "", honoree_name: "", phone: "", amount: "", receipt_number: "", kind: "", donated_on: "" };

export default function DevoteeAddRecordPage() {
  const { user } = useAuth();
  const [f, setF] = useState(EMPTY);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const set = (p: Partial<typeof EMPTY>) => setF((x) => ({ ...x, ...p }));
  const [mine, setMine] = useState<Mine[] | null>(null);
  const [show, setShow] = useState<"all" | "not_printed" | "waiting" | "approved">("all");

  const loadMine = useCallback(async () => {
    try {
      const r = await apiClient.get<{ rows: Mine[] }>("/api/seva-wall/mine");
      setMine(r.rows);
    } catch {
      setMine([]);
    }
  }, []);
  useEffect(() => {
    if (user?.role === "devotee") void loadMine();
  }, [user?.role, loadMine]);

  const phone = f.phone.replace(/\D/g, "");
  const missing = {
    honoree_name: !f.honoree_name.trim(),
    receipt_number: !f.receipt_number.trim(),
    donor_name: !f.donor_name.trim(),
    phone: phone.length < 10,
    amount: !(Number(f.amount) >= 1500),
    kind: !f.kind,
  };
  const invalid = Object.values(missing).some(Boolean);

  async function save() {
    setShown(true);
    setError(null);
    setAdded(null);
    if (invalid) return;
    setBusy(true);
    try {
      await apiClient.post("/api/seva-wall/devotee-record", {
        donor_name: f.donor_name.trim(),
        honoree_name: f.honoree_name.trim(),
        phone,
        amount: f.amount,
        receipt_number: f.receipt_number.trim(),
        kind: f.kind,
        donated_on: f.donated_on,
      });
      setAdded(f.honoree_name.trim());
      setF(EMPTY);
      setShown(false);
      void loadMine();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add the record. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Where every brick this devotee added stands, so they can track how many are printed and how many are not.
  const group = (r: Mine): "not_printed" | "waiting" | "approved" =>
    r.status === "sent" ? "approved" : r.status === "in_review" ? "waiting" : "not_printed";
  const count = (g: "not_printed" | "waiting" | "approved") => (mine ?? []).filter((r) => group(r) === g).length;
  const shown_rows = (mine ?? []).filter((r) => show === "all" || group(r) === show);

  if (user && user.role !== "devotee") {
    return <Alert tone="info">This page is for devotees adding brick records. Use the Seva wall from the menu instead.</Alert>;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-semibold text-ink">Add record</h1>
      <p className="mb-5 text-sm text-ink-muted">The honoree name is printed on the brick.</p>

      {added && <Alert tone="good">Added: {added}. You can add another below.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mt-4 grid gap-4 rounded-panel border border-line-soft bg-surface p-5 shadow-raised sm:grid-cols-2">
        <Field label="Honoree name" required hint="Printed on the brick" error={shown && missing.honoree_name ? "Enter the honoree's name." : undefined}>
          <Input value={f.honoree_name} onChange={(e) => set({ honoree_name: e.target.value })} invalid={shown && missing.honoree_name} />
        </Field>
        <Field label="Donation receipt no." required error={shown && missing.receipt_number ? "Enter the receipt number." : undefined}>
          <Input value={f.receipt_number} onChange={(e) => set({ receipt_number: e.target.value })} invalid={shown && missing.receipt_number} />
        </Field>
        <Field label="Donor name" required error={shown && missing.donor_name ? "Enter the donor name." : undefined}>
          <Input value={f.donor_name} onChange={(e) => set({ donor_name: e.target.value })} invalid={shown && missing.donor_name} />
        </Field>
        <Field label="Donor phone number" required error={shown && missing.phone ? "Enter the 10-digit number." : undefined}>
          <Input inputMode="numeric" value={f.phone} onChange={(e) => set({ phone: e.target.value })} invalid={shown && missing.phone} />
        </Field>
        <Field label="Amount donated" required error={shown && missing.amount ? "Enter 1500 or more." : undefined}>
          <Input inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value })} invalid={shown && missing.amount} />
        </Field>
        <Field label="Seva" required error={shown && missing.kind ? "Choose the seva." : undefined}>
          <Select value={f.kind} onChange={(v) => set({ kind: v })} placeholder="Choose…" ariaLabel="Seva">
            <option value="brick">Brick seva</option>
            <option value="square">Square foot seva</option>
            <option value="mandir">Mandir nirmana seva</option>
          </Select>
        </Field>
        <Field label="Donation date" hint="Optional">
          <Input type="date" value={f.donated_on} onChange={(e) => set({ donated_on: e.target.value })} />
        </Field>
        <div className="flex items-end sm:justify-end">
          <Button size="lg" block loading={busy} onClick={() => void save()}>
            {busy ? "Adding…" : "Add record"}
          </Button>
        </div>
      </div>

      <h2 className="mb-2 mt-8 text-base font-semibold text-ink">Your records</h2>
      {mine && mine.length > 0 && (
        <div className="mb-3 overflow-x-auto">
          <SegmentedControl
            options={[
              { value: "all", label: `All (${mine.length})` },
              { value: "not_printed", label: `Not printed (${count("not_printed")})` },
              { value: "waiting", label: `Printed, waiting for approval (${count("waiting")})` },
              { value: "approved", label: `Approved (${count("approved")})` },
            ]}
            value={show}
            onChange={(v) => setShow(v as typeof show)}
            solid
          />
        </div>
      )}
      <TableShell>
        <Thead>
          <Th>Picture</Th>
          <Th>Honoree name</Th>
          <Th>Donor</Th>
          <Th>Donor number</Th>
          <Th>Seva</Th>
          <Th align="right">Amount</Th>
          <Th>Receipt no.</Th>
          <Th>Added</Th>
          <Th>Status</Th>
          <Th>WhatsApp</Th>
        </Thead>
        <Tbody>
          {mine === null ? (
            <tr>
              <td colSpan={10} className="px-4 py-8 text-center text-sm text-ink-muted">Loading…</td>
            </tr>
          ) : shown_rows.length === 0 ? (
            <tr>
              <td colSpan={10}>
                <EmptyState
                  icon="box"
                  title={mine.length === 0 ? "No records yet" : "Nothing here"}
                  message={
                    mine.length === 0
                      ? "The bricks you add appear here. Those not printed yet come first, and each picture appears once a caller has approved it."
                      : "None of your bricks are in this group."
                  }
                />
              </td>
            </tr>
          ) : (
            shown_rows.map((r) => {
              const st = standing(r);
              return (
                <tr key={r.ref}>
                  <Td>{r.has_image ? <Thumb row={r} /> : <span className="text-ink-faint">-</span>}</Td>
                  <Td>{r.honoree_name || <span className="text-ink-faint">-</span>}</Td>
                  <Td>{r.donor_name || "-"}</Td>
                  <Td className="tabular-nums">{r.phone || "-"}</Td>
                  <Td>{KIND_WORDS[r.kind]}</Td>
                  <Td align="right">{currency(r.amount)}</Td>
                  <Td>{r.receipt_number || "-"}</Td>
                  <Td>{shortDate(r.created_at)}</Td>
                  <Td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </Td>
                  <Td>
                    <WhatsAppLink row={r} />
                  </Td>
                </tr>
              );
            })
          )}
        </Tbody>
      </TableShell>
    </div>
  );
}
