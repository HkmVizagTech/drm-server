"use client";

// Money a caller collected that no system watched arrive.
//
// THE CASE THIS SCREEN EXISTS FOR
// A caller rings a donor, the donor says "send me the number", and the caller
// sends the temple's PhonePe or UPI number. The donor pays. That money lands
// in the temple's bank account and touches nothing DRM can see: no Razorpay
// webhook, no site donation to sync. As far as every other screen is
// concerned the call produced nothing, and at month end the caller shows a
// figure missing the part they worked hardest for.
//
// So they write it down here, and DRM counts it — with the fact that it is
// their own word attached to it, visibly, until somebody checks it.
//
// WHY "AWAITING A CHECK" IS NOT AN ACCUSATION
// Every other credit in the ledger records something a machine observed. This
// one records something a person reported. Those are different kinds of fact
// and showing them identically would be lying by omission - the first time a
// figure is questioned, nobody could say which part of it was observed. An
// unchecked row means nobody has opened the bank statement yet. It does not
// mean anybody doubts it, and the wording on this screen is chosen to say so.
//
// WHY RECORDING AND RECEIPTING ARE TWO BUTTONS
// A mis-recorded collection can be reversed in one click. A wrongly issued 80G
// receipt cannot be withdrawn at all - it is a numbered certificate filed with
// the tax office. So recording writes nothing to either donation site, and
// raising the receipt is a separate, deliberate act with its own warning.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, dateTime, istToday, number, relativeDate, shortDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Toolbar,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";
import { DonorFields, emptyReceipt, receiptProblems, type ReceiptValues } from "@/components/receipts/receipt-form";

interface Collection {
  /** The credit id. Every action on this screen is addressed to it. */
  id: string;
  amount: string;
  occurred_at: string;
  note: string | null;
  verified_at: string | null;
  caller_name: string;
  verified_by_name: string | null;
  donor_name: string | null;
  donor_phone: string | null;
  method: string | null;
  /** The UTR or PhonePe reference. Without it no receipt can be raised. */
  reference: string | null;
  receipt_status: string | null;
  receipt_number: string | null;
  receipt_site: string | null;
  sevak_name: string | null;
  donor_email?: string | null;
  donor_pan?: string | null;
  donor_address?: string | null;
  purpose?: string | null;
  receipt_error?: string | null;
  /** The lead this payment landed on, when it was from one. */
  lead_name?: string | null;
}

interface CollectionsResponse {
  collections: Collection[];
  total: number;
  amount: number;
  awaiting: number;
  awaiting_count: number;
  /** False when the list is capped — the totals beside it still cover everything. */
  complete: boolean;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

// Three, not a free-text box, because the receipt the site raises can only say
// one of these - everything that is not cash or a cheque is booked as UPI. A
// fourth option would be a choice that quietly becomes one of these anyway.
const METHODS = [
  { value: "upi", label: "UPI" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];


const CREDITABLE = ["caller", "admin", "accountant"];

export default function CollectedByHandPage() {
  const { user } = useAuth();
  // Admin and accountant only, and deliberately not the person who recorded
  // it: the whole value of the mark is that a second pair of eyes found the
  // money in the bank. The server enforces this; the screen matches it so a
  // caller is not shown buttons that answer 403.
  const canVerify = user?.role === "admin" || user?.role === "accountant";
  const canChooseCaller = !!user && user.role !== "caller";

  const [verified, setVerified] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [userId, setUserId] = useState("");

  const [data, setData] = useState<CollectionsResponse | null>(null);
  const [callers, setCallers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [receipting, setReceipting] = useState<Collection | null>(null);
  const [reversing, setReversing] = useState<Collection | null>(null);

  // Typing a donor's name is six keystrokes and six list requests otherwise,
  // each one a scan of the credits table. 300ms is what every other search box
  // in this admin waits.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  /** The filters, described once, so the download cannot cover a wider set than the screen. */
  const filterParams = useCallback(() => {
    const p = new URLSearchParams({ limit: "200" });
    if (verified) p.set("verified", verified);
    if (fromDate) p.set("from_date", fromDate);
    if (toDate) p.set("to_date", toDate);
    if (debouncedSearch.trim()) p.set("search", debouncedSearch.trim());
    if (userId) p.set("user_id", userId);
    return p;
  }, [verified, fromDate, toDate, debouncedSearch, userId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiClient.get<CollectionsResponse>(`/api/crm/collections?${filterParams()}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
    } finally {
      setLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canChooseCaller) return;
    apiClient
      .get<{ users: TeamMember[] }>("/api/crm/config")
      // The list below is the screen; a dropdown that failed to populate is
      // not a reason to show an error instead of the money.
      .then((c) => setCallers(c.users.filter((u) => CREDITABLE.includes(u.role))))
      .catch(() => undefined);
  }, [canChooseCaller]);

  async function tickOff(c: Collection) {
    setBusy(c.id);
    setError(null);
    try {
      await apiClient.post(`/api/crm/collections/${c.id}/verify`, {});
      setNotice(`${currency(Number(c.amount))} from ${c.donor_name ?? "this donor"} checked.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(null);
    }
  }

  const activeFilters = [verified, fromDate, toDate, debouncedSearch, userId].filter(Boolean).length;
  // The caller column goes with the caller filter, not with the right to tick
  // a row off: a volunteer coordinator reading everybody's collections needs
  // to see whose each one is even though they may not verify it.
  const cols = canChooseCaller ? 8 : 7;
  // Read off the role rather than off `!canChooseCaller`: that is false for the
  // moment before /auth/me answers, so an admin would see "Money you collected"
  // flash above the whole temple's figures on every load.
  const mine = user?.role === "caller";

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Collected by PhonePe"
        subtitle="Money paid to the temple's PhonePe or UPI number."
        actions={
          <>
            <ExportButton
              path="/api/crm/collections/export"
              params={filterParams()}
              filename="collected-by-phonepe"
              hint={data ? `${number(data.total)} entr${data.total === 1 ? "y" : "ies"}` : undefined}
            />
            <Button icon="plus" onClick={() => setRecording(true)}>
              Add payment
            </Button>
          </>
        }
      />

      <Toolbar
        activeCount={activeFilters}
        onClear={() => {
          setVerified("");
          setFromDate("");
          setToDate("");
          setSearch("");
          setUserId("");
        }}
      >
        <Field label="Checked" className="w-48">
          <Select
            value={verified}
            onChange={setVerified}
            ariaLabel="Checked"
            placeholder="All"
            options={[
              { value: "", label: "All" },
              { value: "no", label: "Not checked yet" },
              { value: "yes", label: "Checked" },
            ]}
          />
        </Field>
        {/* A bare YYYY-MM-DD is what the server wants and what it anchors at
            IST midnight, so these are passed through untouched. */}
        <Field label="From" className="w-40">
          <Input type="date" value={fromDate} max={toDate || undefined} onChange={(e) => setFromDate(e.target.value)} />
        </Field>
        <Field label="To" className="w-40">
          <Input type="date" value={toDate} min={fromDate || undefined} onChange={(e) => setToDate(e.target.value)} />
        </Field>
        {canChooseCaller && (
          <Field label="Caller" className="w-48">
            <Select
              value={userId}
              onChange={setUserId}
              ariaLabel="Caller"
              placeholder="Everyone"
              options={[
                { value: "", label: "Everyone" },
                ...callers.map((c) => ({ value: c.id, label: c.name, hint: c.role.replace(/_/g, " ") })),
              ]}
            />
          </Field>
        )}
        <Field label="Find" className="w-56">
          <SearchInput value={search} onChange={setSearch} placeholder="Donor, mobile or UTR" />
        </Field>
      </Toolbar>

      {notice && <Alert tone="good" onDismiss={() => setNotice(null)}>{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile
          label={mine ? "You collected" : "Collected"}
          value={currency(data?.amount ?? 0)}
          loading={loading}
          accent="brand"
          icon="rupee"
          sub={data ? `${number(data.total)} donation${data.total === 1 ? "" : "s"}` : undefined}
        />
        <StatTile
          label="Not checked yet"
          value={currency(data?.awaiting ?? 0)}
          loading={loading}
          accent={data && data.awaiting > 0 ? "warn" : "default"}
          icon="clock"
          sub={data ? `${number(data.awaiting_count)} to check` : undefined}
        />
        <StatTile
          label="Checked"
          value={currency((data?.amount ?? 0) - (data?.awaiting ?? 0))}
          loading={loading}
          accent="good"
          icon="checkCircle"
          sub="Found in bank"
        />
      </div>

      {/* The plain-words version, on the screen rather than in a tooltip. The
          people reading this are the ones whose money it is. */}
      <Alert tone="info">
        Counted now. An admin checks it in the bank later.{" "}
        <Link href="/calling/earnings" className="font-medium text-brand-700 hover:underline">
          Money raised
        </Link>
      </Alert>

      {/* THE VERIFICATION QUEUE, OFFERED RATHER THAN HIDDEN IN A DROPDOWN.
          Reconciling is a job somebody sits down to do, and a filter nobody
          finds is money that stays unchecked - which is the whole reason the
          awaiting figure exists. Only shown to the people who can actually
          tick a row off, and only while there is something to tick. */}
      {canVerify && data && data.awaiting_count > 0 && verified !== "no" && (
        <Alert
          tone="warn"
          title={`${currency(data.awaiting)} from ${number(data.awaiting_count)} payment${
            data.awaiting_count === 1 ? "" : "s"
          } not checked yet`}
          action={
            <Button variant="secondary" onClick={() => setVerified("no")}>
              Check them
            </Button>
          }
        />
      )}

      {data && !data.complete && (
        <Alert tone="warn">
          Showing {number(data.collections.length)} of {number(data.total)}. Pick dates to see more.
        </Alert>
      )}

      <TableShell>
        <Thead>
          <Th>Date</Th>
          <Th>Donor</Th>
          <Th align="right">Amount</Th>
          <Th>Paid by</Th>
          {canChooseCaller && <Th>Caller</Th>}
          <Th>Checked</Th>
          <Th>Receipt</Th>
          <Th align="right">Actions</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={6} cols={cols} />
        ) : (
          <Tbody>
            {!data?.collections.length ? (
              <tr>
                <td colSpan={cols}>
                  <EmptyCollections
                    filtered={activeFilters > 0}
                    queue={verified === "no"}
                    onRecord={() => setRecording(true)}
                  />
                </td>
              </tr>
            ) : (
              data.collections.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap text-xs text-ink-muted">
                    {shortDate(c.occurred_at)}
                    <div className="text-ink-faint">
                      {clockTime(c.occurred_at)} · {relativeDate(c.occurred_at)}
                    </div>
                  </Td>
                  <Td>
                    <span className="block text-sm font-medium text-ink">
                      {c.donor_name || <span className="text-ink-faint">No name</span>}
                    </span>
                    {c.donor_phone && (
                      <span className="block text-xs tabular-nums text-ink-muted">{c.donor_phone}</span>
                    )}
                    {c.sevak_name && <span className="block text-2xs text-ink-faint">On the name of {c.sevak_name}</span>}
                    {c.lead_name && <span className="block text-2xs text-good">Lead: {c.lead_name} · Donated</span>}
                  </Td>
                  <Td align="right" className="whitespace-nowrap font-medium tabular-nums text-ink">
                    {currency(Number(c.amount))}
                  </Td>
                  <Td>
                    <span className="block text-xs uppercase tracking-wide text-ink-muted">{c.method ?? "upi"}</span>
                    {/* The reference is the whole point of the row, so a
                        missing one is called out here rather than only at the
                        moment somebody tries to raise the receipt and is
                        refused. */}
                    {c.reference ? (
                      <span className="block max-w-[12rem] truncate text-xs tabular-nums text-ink-soft">
                        {c.reference}
                      </span>
                    ) : (
                      <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-warn">
                        <Icon name="alert" size={12} />
                        No UTR yet
                      </span>
                    )}
                  </Td>
                  {canChooseCaller && <Td className="text-sm">{c.caller_name}</Td>}
                  <Td>
                    {c.verified_at ? (
                      <span>
                        <Badge tone="good" dot>
                          Checked
                        </Badge>
                        {c.verified_by_name && (
                          <div className="mt-0.5 text-2xs text-ink-muted">by {c.verified_by_name}</div>
                        )}
                      </span>
                    ) : (
                      <Badge tone="warn" dot>
                        Not checked yet
                      </Badge>
                    )}
                  </Td>
                  <Td>{receiptCell(c)}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {canVerify && !c.verified_at && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon="check"
                          loading={busy === c.id}
                          onClick={() => void tickOff(c)}
                        >
                          Mark checked
                        </Button>
                      )}
                      {c.receipt_status !== "issued" && (
                        <Button size="sm" variant="ghost" icon="receipt" onClick={() => setReceipting(c)}>
                          Send receipt
                        </Button>
                      )}
                      {canVerify && (
                        <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => setReversing(c)}>
                          Remove
                        </Button>
                      )}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </Tbody>
        )}
      </TableShell>



      {recording && (
        <RecordDialog
          onClose={() => setRecording(false)}
          onDone={async (what, sendFor) => {
            setRecording(false);
            setNotice(what);
            await load();
            // "Save & send receipt": straight on to the receipt, filled in.
            if (sendFor) setReceipting(sendFor);
          }}
        />
      )}

      {receipting && (
        <ReceiptDialog
          collection={receipting}
          onClose={() => setReceipting(null)}
          onDone={async (what) => {
            setReceipting(null);
            setNotice(what);
            await load();
          }}
        />
      )}

      {reversing && (
        <ReverseDialog
          collection={reversing}
          onClose={() => setReversing(null)}
          onDone={async (what) => {
            setReversing(null);
            setNotice(what);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Three empties, not one.
 *
 * An emptied verification queue is good news and deserves to read as such;
 * an empty filtered list is a dead end that wants the filters cleared; an
 * empty unfiltered list is somebody's first visit and wants the form. One
 * generic "no records" message would be wrong in two of the three.
 */
function EmptyCollections({
  filtered,
  queue,
  onRecord,
}: {
  filtered: boolean;
  queue: boolean;
  onRecord: () => void;
}) {
  if (queue) {
    return (
      <EmptyState
        icon="checkCircle"
        title="All checked"
        message="Nothing waiting."
      />
    );
  }
  if (filtered) {
    return (
      <EmptyState
        icon="inbox"
        title="No match"
        message="Clear filters or pick other dates."
      />
    );
  }
  return (
    <EmptyState
      icon="rupee"
      title="Nothing added yet"
      message="Add money paid to the temple's PhonePe or UPI."
      action={
        <Button icon="plus" onClick={onRecord}>
          Add payment
        </Button>
      }
    />
  );
}

function receiptCell(c: Collection) {
  if (c.receipt_status === "issued") {
    return (
      <span>
        <Badge tone="good">Sent</Badge>
        {c.receipt_number && <div className="mt-0.5 text-2xs tabular-nums text-ink-muted">{c.receipt_number}</div>}
      </span>
    );
  }
  if (c.receipt_status === "pending") return <Badge tone="neutral">In progress</Badge>;
  if (c.receipt_status === "failed") return <Badge tone="danger">Failed</Badge>;
  return <Badge tone="warn">Not sent</Badge>;
}

/* ------------------------------------------------------------ record a collection */

/**
 * Writing down money that has already arrived.
 *
 * The donor's name and number are required because without them the money
 * cannot be given back to a person later - a credit with no donor is a figure
 * nobody can follow up, thank, or receipt. The reference is not required by
 * the server, and this form does not pretend otherwise; it nags instead,
 * because a caller standing in front of a donor often genuinely does not have
 * the UTR yet and refusing the whole record would mean the money is not
 * written down at all.
 */
function RecordDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (notice: string, sendReceiptFor?: Collection) => Promise<void> | void;
}) {
  const [amount, setAmount] = useState("");
  const [donorName, setDonorName] = useState("");
  const [donorPhone, setDonorPhone] = useState("");
  const [reference, setReference] = useState("");
  const [method, setMethod] = useState("upi");
  const [at, setAt] = useState(istToday());
  const [purpose, setPurpose] = useState("");
  const [donorEmail, setDonorEmail] = useState("");
  const [donorPan, setDonorPan] = useState("");
  const [donorAddress, setDonorAddress] = useState("");
  const [sevakName, setSevakName] = useState("");
  const [note, setNote] = useState("");
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const phoneDigits = donorPhone.replace(/\D/g, "");
  const ready = Number(amount) > 0 && donorName.trim().length > 0 && phoneDigits.length >= 10;
  const [known, setKnown] = useState<string | null>(null);

  // A donor DRM already knows fills themselves in - only blanks, never over
  // what was typed. Same lookup as the other receipt forms.
  const mobile10 = phoneDigits.slice(-10);
  useEffect(() => {
    if (mobile10.length !== 10) return;
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<{ people: Record<string, unknown>[] }>(
          `/api/people?search=${encodeURIComponent(mobile10)}&limit=1`
        );
        const p = r.people?.[0];
        if (!live) return;
        setKnown(p ? "Known donor - details filled in" : null);
        if (!p) return;
        setDonorName((x) => x || String(p.name ?? ""));
        setDonorEmail((x) => x || String(p.email ?? ""));
        setDonorPan((x) => x || String(p.pan ?? ""));
        setDonorAddress((x) => x || String(p.prasadam_address ?? p.address ?? ""));
      } catch {
        /* a convenience; the form works without it */
      }
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [mobile10]);

  async function save(thenReceipt: boolean) {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{
        credit_id: string;
        occurred_at: string;
        lead: { id: string; name: string | null; replaced_said?: number | null } | null;
      }>("/api/crm/collections", {
        amount: Number(amount),
        donor_name: donorName.trim(),
        donor_phone: phoneDigits,
        donor_email: donorEmail.trim() || undefined,
        donor_pan: donorPan.trim() || undefined,
        donor_address: donorAddress.trim() || undefined,
        purpose: purpose.trim() || undefined,
        method,
        reference: reference.trim() || undefined,
        sevak_name: sevakName.trim() || undefined,
        // A bare YYYY-MM-DD, sent as the input gave it. The server
        // anchors it at IST midnight; wrapping it in a Date here
        // would read it in the browser's zone and book a Friday
        // collection on Thursday for anyone west of the temple.
        at,
        note: note.trim() || undefined,
      });
      const amt = currency(Number(amount));
      const who = donorName.trim();
      // Said plainly when it landed on a lead, and when it took the place of
      // the amount noted on the call - so nobody adds it a second time.
      const onLead = r.lead
        ? r.lead.replaced_said !== undefined && r.lead.replaced_said !== null
          ? ` Counted once with the ${currency(Number(r.lead.replaced_said))} noted on the call.`
          : ` ${r.lead.name ?? "Their lead"} is marked Donated.`
        : "";
      const notice = `${amt} from ${who} saved.${onLead}${reference.trim() ? "" : " Add the UTR later."}`;
      await onDone(
        notice,
        thenReceipt
          ? {
              id: r.credit_id,
              amount: String(Number(amount)),
              occurred_at: r.occurred_at,
              note: null,
              verified_at: null,
              caller_name: "",
              verified_by_name: null,
              donor_name: who,
              donor_phone: phoneDigits.slice(-10),
              method,
              reference: reference.trim() || null,
              receipt_status: null,
              receipt_number: null,
              receipt_site: null,
              sevak_name: sevakName.trim() || null,
              donor_email: donorEmail.trim() || null,
              donor_pan: donorPan.trim() || null,
              donor_address: donorAddress.trim() || null,
              purpose: purpose.trim() || null,
            }
          : undefined
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add payment"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={reference.trim() ? "secondary" : "primary"} loading={busy} disabled={!ready} onClick={() => save(false)}>
            Save
          </Button>
          {/* One step when the UTR is in hand: save, then the receipt form
              opens already filled in. */}
          {reference.trim() && (
            <Button loading={busy} disabled={!ready} onClick={() => save(true)}>
              Save &amp; send receipt
            </Button>
          )}
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}



      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount" htmlFor="col-amount" required>
          <Input
            id="col-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="5000"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>
        <Field label="Date" htmlFor="col-at">
          <Input id="col-at" type="date" value={at} max={istToday()} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="Donor Name" htmlFor="col-name" required>
          <Input id="col-name" value={donorName} onChange={(e) => setDonorName(e.target.value)} />
        </Field>
        <Field label="Mobile Number" htmlFor="col-phone" required hint={known ?? undefined}>
          <Input
            id="col-phone"
            value={donorPhone}
            onChange={(e) => setDonorPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
        <Field label="Paid by">
          <Select value={method} onChange={setMethod} ariaLabel="Paid by" options={METHODS} />
        </Field>
        <Field label="Transaction ID (UTR) / Cheque No." htmlFor="col-ref" hint="12 digits on the PhonePe screen">
          <Input
            id="col-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="e.g. 431802274915"
            className="tabular-nums"
          />
        </Field>
      </div>

      {/* The nag. Worth a whole banner rather than a line of hint text: this
          one string is what ties the certificate to a line on the statement,
          what lets the accountant find the money at all, and what makes a
          retry safe - both sites refuse a duplicate reference, so with it a
          second press cannot mint a second receipt. */}
      {!reference.trim() && (
        <Alert tone="warn" className="mt-4">
          No UTR? You can save now. The receipt needs the UTR.
        </Alert>
      )}

      <div className="mt-4 border-t border-line-soft pt-3">
        <Button variant="ghost" size="sm" icon={more ? "chevronUp" : "chevronDown"} onClick={() => setMore((v) => !v)}>
          {more ? "Hide receipt details" : "Receipt details"}
        </Button>
        {more && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="E-mail ID (optional)" htmlFor="col-email">
              <Input id="col-email" type="email" value={donorEmail} onChange={(e) => setDonorEmail(e.target.value)} />
            </Field>
            {/* The site only sends an 80G certificate when it has a PAN, so
                this field decides whether the donor gets one at all. */}
            <Field label="PAN Number" htmlFor="col-pan" hint="Needed for 80G Tax Exemption">
              <Input
                id="col-pan"
                value={donorPan}
                onChange={(e) => setDonorPan(e.target.value.toUpperCase())}
                maxLength={10}
                className="uppercase tabular-nums"
              />
            </Field>
            <Field label="Seva" htmlFor="col-purpose">
              <Input id="col-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Annadan" />
            </Field>
            <Field label="On the name of" htmlFor="col-sevak">
              <Input id="col-sevak" value={sevakName} onChange={(e) => setSevakName(e.target.value)} />
            </Field>
            <Field label="Address" htmlFor="col-address" className="sm:col-span-2">
              <Input id="col-address" value={donorAddress} onChange={(e) => setDonorAddress(e.target.value)} />
            </Field>
            <Field label="Note" htmlFor="col-note" className="sm:col-span-2">
              <Textarea id="col-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- raise the receipt */

/**
 * The step that creates something real on a live site.
 *
 * Everything before this was DRM's own bookkeeping. This posts an offline
 * donation to HKMV or annadan, which mints an 80G receipt number, files it and
 * sends the donor their certificate. It cannot be undone from here, so it says
 * so above the button - and the button carries a loading state so it cannot be
 * pressed twice while the first call is still in flight.
 */
function ReceiptDialog({
  collection,
  onClose,
  onDone,
}: {
  collection: Collection;
  onClose: () => void;
  onDone: (notice: string) => Promise<void> | void;
}) {
  // The entry's own details, filled in - the caller only completes what is
  // missing (often just the UTR or the PAN) and presses Send. Same form as a
  // QR payment's receipt, so both look and work the same.
  const [v, setV] = useState<ReceiptValues>(() => ({
    ...emptyReceipt(),
    donorName: collection.donor_name ?? "",
    mobile: collection.donor_phone ?? "",
    email: collection.donor_email ?? "",
    seva: collection.purpose ?? "",
    onNameOf: collection.sevak_name ?? "",
    pan: collection.donor_pan ?? "",
    want80G: !!collection.donor_pan,
    address: collection.donor_address ?? "",
    site: (collection.receipt_site as ReceiptValues["site"]) || "hkmv",
  }));
  const set = (patch: Partial<ReceiptValues>) => setV((x) => ({ ...x, ...patch }));
  const [reference, setReference] = useState(collection.reference ?? "");
  const [method, setMethod] = useState(collection.method ?? "upi");
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(collection.receipt_error ?? null);

  const problem = !reference.trim()
    ? method === "cheque"
      ? "Enter the Cheque No."
      : "Enter the Transaction ID (UTR)."
    : receiptProblems(v, { needSite: true });

  async function send() {
    setShown(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ receipt_status: string; receipt_number?: string }>(
        `/api/crm/collections/${collection.id}/receipt`,
        {
          site: v.site,
          reference: reference.trim(),
          method,
          donor_name: v.donorName.trim(),
          donor_phone: v.mobile.replace(/\D/g, "").slice(-10),
          donor_email: v.email.trim(),
          donor_pan: v.want80G ? v.pan.trim() : undefined,
          donor_address: v.address.trim(),
          purpose: v.seva.trim(),
          sevak_name: v.onNameOf.trim(),
          want_80g: v.want80G,
          want_prasadam: v.wantPrasadam,
        }
      );
      await onDone(
        r.receipt_number
          ? `Receipt No. ${r.receipt_number} sent for ${currency(Number(collection.amount))}.`
          : `Receipt: ${r.receipt_status}.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send receipt. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Send 80G receipt"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={send}>
            Send receipt
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {shown && problem && <Alert tone="warn">{problem}</Alert>}

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2 rounded-card bg-sunken/60 px-3 py-2 text-sm">
        <span className="font-semibold tabular-nums text-ink">{currency(Number(collection.amount))}</span>
        <span className="text-ink-muted">{dateTime(collection.occurred_at)}</span>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <Field label="Paid by">
          <Select value={method} onChange={setMethod} ariaLabel="Paid by" options={METHODS} />
        </Field>
        <Field
          label={method === "cheque" ? "Cheque No." : "Transaction ID (UTR)"}
          htmlFor="rc-ref"
          required
          hint={method === "cheque" ? undefined : "12 digits on the PhonePe screen"}
        >
          <Input
            id="rc-ref"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder={method === "cheque" ? "Cheque No." : "e.g. 431802274915"}
            className="tabular-nums"
          />
        </Field>
      </div>

      <DonorFields v={v} set={set} showPrasadam showSite showMyDonor={false} />

      <p className="mt-4 text-xs text-ink-muted">This cannot be undone. The donor gets the receipt by e-mail.</p>
    </Modal>
  );
}

/* --------------------------------------------------------------------- reverse */

/** Reversing a record that turned out not to be money. */
function ReverseDialog({
  collection,
  onClose,
  onDone,
}: {
  collection: Collection;
  onClose: () => void;
  onDone: (notice: string) => Promise<void> | void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal
      title={`Remove ${currency(Number(collection.amount))}?`}
      tone="danger"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!reason.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                // apiClient.delete() sends no body, and the reason is the
                // whole point of a reversal - so this goes through api()
                // directly rather than quietly reversing with no reason on
                // the row.
                await api<{ reversed: boolean }>(`/api/crm/collections/${collection.id}`, {
                  method: "DELETE",
                  body: JSON.stringify({ reason: reason.trim() }),
                });
                await onDone(`${currency(Number(collection.amount))} removed.`);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not remove. Try again.");
                setBusy(false);
              }
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-4 text-sm text-ink-soft">
        It will no longer count for {collection.caller_name}.
      </p>

      <Field label="Reason" htmlFor="rev-reason" required>
        <Textarea
          id="rev-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Not found in bank"
        />
      </Field>
    </Modal>
  );
}
