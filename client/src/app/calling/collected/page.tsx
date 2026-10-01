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
  { value: "upi", label: "PhonePe / UPI / GPay" },
  { value: "cash", label: "Cash" },
  { value: "cheque", label: "Cheque" },
];

const SITES = [
  { value: "hkmv", label: "harekrishnavizag.org" },
  { value: "annadan", label: "annadan" },
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
      setError(e instanceof Error ? e.message : "Could not load what was collected");
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
      setNotice(`${currency(Number(c.amount))} from ${c.donor_name ?? "that donor"} is ticked off.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check that off");
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
        title={mine ? "Money you collected" : "Money collected by PhonePe"}
        subtitle="Donations taken on the temple's PhonePe or UPI number — counted from the moment they are written down, checked against the bank afterwards"
        actions={
          <>
            <ExportButton
              path="/api/crm/collections/export"
              params={filterParams()}
              filename="collected-by-phonepe"
              hint={data ? `${number(data.total)} record${data.total === 1 ? "" : "s"}` : undefined}
            />
            <Button icon="plus" onClick={() => setRecording(true)}>
              Record a collection
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
            placeholder="Everything"
            options={[
              { value: "", label: "Everything" },
              { value: "no", label: "Awaiting a check", hint: "The verification queue" },
              { value: "yes", label: "Checked off" },
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
          <SearchInput value={search} onChange={setSearch} placeholder="Donor, phone or reference…" />
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
          sub={data ? `${number(data.total)} donation${data.total === 1 ? "" : "s"} recorded` : undefined}
        />
        <StatTile
          label="Awaiting a check"
          value={currency(data?.awaiting ?? 0)}
          loading={loading}
          accent={data && data.awaiting > 0 ? "warn" : "default"}
          icon="clock"
          sub={data ? `${number(data.awaiting_count)} still to be found on the statement` : undefined}
        />
        <StatTile
          label="Checked off"
          value={currency((data?.amount ?? 0) - (data?.awaiting ?? 0))}
          loading={loading}
          accent="good"
          icon="checkCircle"
          sub="matched to a line in the bank"
        />
      </div>

      {/* The plain-words version, on the screen rather than in a tooltip. The
          people reading this are the ones whose money it is. */}
      <Alert tone="info" title="What these rows are">
        Nothing watched this money arrive — it went straight to a PhonePe or UPI number, so there is no webhook and
        no site donation behind it. DRM counts it from the moment it is written down, and marks it as the caller&apos;s
        own report until an admin finds it on the bank statement and ticks it off. Awaiting a check means nobody has
        looked yet, not that anything is wrong.{" "}
        <Link href="/calling/earnings" className="font-medium text-brand-700 hover:underline">
          See it beside everything else raised
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
          title={`${currency(data.awaiting)} across ${number(data.awaiting_count)} collection${
            data.awaiting_count === 1 ? "" : "s"
          } has not been checked`}
          action={
            <Button variant="secondary" onClick={() => setVerified("no")}>
              Work through them
            </Button>
          }
        >
          Open the bank statement beside this and tick off each one you can find.
        </Alert>
      )}

      {data && !data.complete && (
        <Alert tone="warn">
          Showing the newest {number(data.collections.length)} of {number(data.total)}. The totals above cover all of
          them; narrow the dates to work through the rest on screen, or download the file.
        </Alert>
      )}

      <TableShell>
        <Thead>
          <Th>When</Th>
          <Th>Donor</Th>
          <Th align="right">Amount</Th>
          <Th>How it came</Th>
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
                      {c.donor_name || <span className="text-ink-faint">not named</span>}
                    </span>
                    {c.donor_phone && (
                      <span className="block text-xs tabular-nums text-ink-muted">{c.donor_phone}</span>
                    )}
                    {c.sevak_name && <span className="block text-2xs text-ink-faint">for {c.sevak_name}</span>}
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
                        no reference
                      </span>
                    )}
                  </Td>
                  {canChooseCaller && <Td className="text-sm">{c.caller_name}</Td>}
                  <Td>
                    {c.verified_at ? (
                      <span>
                        <Badge tone="good" dot>
                          checked off
                        </Badge>
                        {c.verified_by_name && (
                          <div className="mt-0.5 text-2xs text-ink-muted">by {c.verified_by_name}</div>
                        )}
                      </span>
                    ) : (
                      <Badge tone="warn" dot>
                        awaiting a check
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
                          Tick off
                        </Button>
                      )}
                      {c.receipt_status !== "issued" && (
                        <Button size="sm" variant="ghost" icon="receipt" onClick={() => setReceipting(c)}>
                          Raise receipt
                        </Button>
                      )}
                      {canVerify && (
                        <Button size="sm" variant="dangerSoft" icon="trash" onClick={() => setReversing(c)}>
                          Reverse
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

      <p className="mt-3 text-xs text-ink-muted">
        Reversing does not delete anything: the row stays with the reason on it, stops counting, and frees the money
        to be claimed by whoever actually raised it. A receipt, once raised, cannot be withdrawn from here at all.
      </p>

      {recording && (
        <RecordDialog
          onClose={() => setRecording(false)}
          onDone={async (what) => {
            setRecording(false);
            setNotice(what);
            await load();
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
        title="Nothing waiting to be checked"
        message="Every collection recorded has been found on the statement and ticked off."
      />
    );
  }
  if (filtered) {
    return (
      <EmptyState
        icon="inbox"
        title="Nothing matches those filters"
        message="Clear the filters, or widen the dates."
      />
    );
  }
  return (
    <EmptyState
      icon="rupee"
      title="Nothing recorded yet"
      message="When a donor pays straight to the temple's PhonePe or UPI number, record it here so it counts towards what you raised."
      action={
        <Button icon="plus" onClick={onRecord}>
          Record a collection
        </Button>
      }
    />
  );
}

function receiptCell(c: Collection) {
  if (c.receipt_status === "issued") {
    return (
      <span>
        <Badge tone="good">issued</Badge>
        {c.receipt_number && <div className="mt-0.5 text-2xs tabular-nums text-ink-muted">{c.receipt_number}</div>}
      </span>
    );
  }
  if (c.receipt_status === "pending") return <Badge tone="neutral">in progress</Badge>;
  if (c.receipt_status === "failed") return <Badge tone="danger">refused</Badge>;
  return <Badge tone="warn">not raised</Badge>;
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
  onDone: (notice: string) => Promise<void> | void;
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

  return (
    <Modal
      title="Record money you collected"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!ready}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post("/api/crm/collections", {
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
                await onDone(
                  reference.trim()
                    ? `${currency(Number(amount))} from ${donorName.trim()} recorded.`
                    : `${currency(Number(amount))} from ${donorName.trim()} recorded — add the reference when you have it, or the receipt cannot be raised.`
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not record that");
                setBusy(false);
              }
            }}
          >
            Record it
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-4 text-sm text-ink-muted">
        For a donation that went straight to the temple's PhonePe or UPI number. It counts towards what you raised from the
        moment you save it, marked as your own report until an admin finds it on the bank statement. This writes
        nothing to either donation site — the 80G receipt is a separate step.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="How much" htmlFor="col-amount" required>
          <Input
            id="col-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="5000"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>
        <Field label="When it arrived" htmlFor="col-at" hint="Write up Friday's shift on Monday and Friday still shows it">
          <Input id="col-at" type="date" value={at} max={istToday()} onChange={(e) => setAt(e.target.value)} />
        </Field>
        <Field label="Who gave it" htmlFor="col-name" required>
          <Input id="col-name" value={donorName} onChange={(e) => setDonorName(e.target.value)} />
        </Field>
        <Field
          label="Their mobile"
          htmlFor="col-phone"
          required
          hint="Ten digits, so the donor can be found again"
        >
          <Input
            id="col-phone"
            value={donorPhone}
            onChange={(e) => setDonorPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
        <Field label="How it came">
          <Select value={method} onChange={setMethod} ariaLabel="How it came" options={METHODS} />
        </Field>
        <Field
          label="Reference"
          htmlFor="col-ref"
          hint="The UTR, the PhonePe reference, or the cheque number"
        >
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
        <Alert tone="warn" className="mt-4" title="No reference yet?">
          You can still save this and add it later. But until there is one, the 80G receipt cannot be raised and
          nobody reconciling the bank statement can find this money on it.
        </Alert>
      )}

      <div className="mt-4 border-t border-line-soft pt-3">
        <Button variant="ghost" size="sm" icon={more ? "chevronUp" : "chevronDown"} onClick={() => setMore((v) => !v)}>
          {more ? "Fewer details" : "Details for the receipt"}
        </Button>
        {more && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Email" htmlFor="col-email">
              <Input id="col-email" type="email" value={donorEmail} onChange={(e) => setDonorEmail(e.target.value)} />
            </Field>
            {/* The site only sends an 80G certificate when it has a PAN, so
                this field decides whether the donor gets one at all. */}
            <Field label="PAN" htmlFor="col-pan" hint="Without it the site cannot send an 80G certificate">
              <Input
                id="col-pan"
                value={donorPan}
                onChange={(e) => setDonorPan(e.target.value.toUpperCase())}
                maxLength={10}
                className="uppercase tabular-nums"
              />
            </Field>
            <Field label="What it is for" htmlFor="col-purpose">
              <Input id="col-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Annadan" />
            </Field>
            <Field label="On the name of" htmlFor="col-sevak" hint="If the donor asked for the seva in somebody else's name">
              <Input id="col-sevak" value={sevakName} onChange={(e) => setSevakName(e.target.value)} />
            </Field>
            <Field label="Address" htmlFor="col-address" className="sm:col-span-2">
              <Input id="col-address" value={donorAddress} onChange={(e) => setDonorAddress(e.target.value)} />
            </Field>
            <Field label="Anything worth noting" htmlFor="col-note" className="sm:col-span-2">
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
  const [site, setSite] = useState(collection.receipt_site ?? "hkmv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = !collection.reference;

  return (
    <Modal
      title="Raise the 80G receipt"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={blocked}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await apiClient.post<{ receipt_status: string; receipt_number?: string }>(
                  `/api/crm/collections/${collection.id}/receipt`,
                  { site }
                );
                await onDone(
                  r.receipt_number
                    ? `Receipt ${r.receipt_number} raised for ${currency(Number(collection.amount))}.`
                    : `The receipt is ${r.receipt_status}.`
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : "The site refused that receipt");
                setBusy(false);
              }
            }}
          >
            Raise it
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      {blocked ? (
        <Alert tone="warn" title="There is no reference on this record">
          The UTR or PhonePe reference is what ties the certificate to a line on the bank statement, and it is also
          what stops a retry minting a second receipt — both sites refuse a duplicate reference. Add it to the
          record first.
        </Alert>
      ) : (
        <Alert tone="warn" title="This cannot be undone">
          Pressing this creates a real donation on the site you pick. It mints a numbered 80G certificate, files it,
          and emails the donor. Nothing on this screen can withdraw it afterwards.
        </Alert>
      )}

      <dl className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-ink-muted">Donor</dt>
          <dd className="text-ink">{collection.donor_name ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Amount</dt>
          <dd className="font-medium tabular-nums text-ink">{currency(Number(collection.amount))}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Arrived</dt>
          <dd className="text-ink">{dateTime(collection.occurred_at)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">Reference</dt>
          <dd className="tabular-nums text-ink">{collection.reference ?? "—"}</dd>
        </div>
      </dl>

      <Field label="Which site should issue it" hint="Pick the one the donor would recognise giving to">
        <Select value={site} onChange={setSite} ariaLabel="Which site should issue it" options={SITES} disabled={blocked} />
      </Field>
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
      title={`Reverse ${currency(Number(collection.amount))}?`}
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
                await onDone(`${currency(Number(collection.amount))} reversed. The row keeps the reason you gave.`);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not reverse that");
                setBusy(false);
              }
            }}
          >
            Reverse it
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-4 text-sm text-ink-soft">
        This stops {collection.caller_name} being credited with {currency(Number(collection.amount))} from{" "}
        {collection.donor_name ?? "this donor"}. The row is not deleted: it stays with your reason on it, which is
        worth more than no record at all, and the money becomes free for whoever actually raised it to claim.
      </p>

      <Field label="Why" htmlFor="rev-reason" required hint="Whoever reads this row in six months has only this line">
        <Textarea
          id="rev-reason"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Could not be found on the statement"
        />
      </Field>
    </Modal>
  );
}
