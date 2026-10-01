"use client";

// The calling dashboard.
//
// Every tile here says what it counts, because this screen is read by the
// people whose work it measures and a number whose label is slightly wrong is
// worse than no number. The definitions live server-side in
// server/src/routes/crmReports.ts and the captions below repeat them in plain
// words rather than restating the label.
//
// THE CAVEAT THAT MATTERS
// Nobody is running a telephony switch, so call length and whether a call
// connected are what the caller reported, not what a system measured. The API
// returns `measured` alongside every call figure - how many rows came from a
// provider - and this screen says "self-reported" whenever that is zero. The
// day a provider is wired in, the caveat disappears on its own.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  SegmentedControl,
  Select,
  StatTile,
  Textarea,
  Toolbar,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";

interface Dashboard {
  range: { from: string; to: string; label: string };
  /**
   * Whose figures these are, decided by the server from the role - not by
   * anything this page asks for. A caller gets "mine" and sees their own work;
   * an admin gets "team". The page reads it rather than inferring from the
   * role, so the heading can never claim one thing while the numbers are the
   * other.
   */
  scope: "mine" | "team";
  leads: {
    received: number;
    converted: number;
    conversion_rate: number;
    raised: number;
    /** Of `raised`, how much has a receipt from one of the sites behind it. */
    raised_receipted: number;
    converted_unreceipted: number;
    /** Donors whose money arrived in this window, however long ago they were added. */
    donors_paid: number;
  };
  calls: {
    made: number;
    connected: number;
    unanswered: number;
    connect_rate: number;
    leads_touched: number;
    avg_duration_seconds: number | null;
    with_duration: number;
    measured: number;
    self_reported: number;
  };
  pipeline: { value: number; open_leads: number };
  follow_ups: { overdue: number; today: number; next_7_days: number; unscheduled: number };
  by_status: { status: string; label: string; tone: string; n: number; value: string }[];
  by_source: { source: string; n: number; converted: number }[];
  callers_today: { id: string; name: string; calls: number; connected: number }[];
  qr: {
    shared: number;
    paid: number;
    raised: number;
    awaiting: number;
    /** Every rupee through a QR in this period, attributed or not. */
    through_qrs: number;
    unattributed: number;
  };
  by_qr: {
    id: string;
    qr_id: string;
    label: string;
    purpose: string | null;
    owner_name: string | null;
    raised: number;
    payments: number;
    unattributed: number;
  }[];
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "week", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "quarter", label: "90 days" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

const SOURCE_LABELS: Record<string, string> = {
  donor: "Existing donors",
  csv: "Uploaded lists",
  website: "Website enquiries",
  walk_in: "Walk-ins",
  referral: "Referrals",
  event: "Events",
  manual: "Added by hand",
};

function mins(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export default function CallingDashboardPage() {
  const [preset, setPreset] = useState("month");
  const [outside, setOutside] = useState(false);
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiClient.get<Dashboard>(`/api/crm/dashboard?preset=${preset}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the dashboard");
    } finally {
      setLoading(false);
    }
  }, [preset]);

  useEffect(() => {
    void load();
  }, [load]);

  const c = data?.calls;
  const f = data?.follow_ups;
  const maxStatus = Math.max(1, ...(data?.by_status ?? []).map((s) => s.n));
  // A caller's own screen. Not a cut-down admin dashboard: the same honest
  // figures about a smaller thing, with the two cards that only make sense
  // across a team swapped for the one thing a caller cannot otherwise see -
  // whether the QRs they sent were ever paid.
  const mine = data?.scope === "mine";

  // Built as one string rather than nested fragments so the warning can be the
  // Alert's own title: the banner reads as one sentence either way, and the
  // "·" only appears when both halves are there.
  const owed = f
    ? [
        f.overdue > 0 ? `${number(f.overdue)} callback${f.overdue === 1 ? "" : "s"} overdue` : null,
        f.today > 0 ? `${number(f.today)} due today` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title={mine ? "Your calling" : "Calling"}
        subtitle={
          mine
            ? "Your leads, your calls, and what you are owed — nobody else's"
            : "Phone outreach to donors — what has been done, and what is owed"
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {!mine && (
              <>
                <Link href="/calling/reports" className={buttonSecondary}>
                  Reports
                </Link>
                <Link href="/calling/settings" className={buttonSecondary}>
                  Settings
                </Link>
              </>
            )}
            <Button variant="secondary" icon="phoneOutgoing" onClick={() => setOutside(true)}>
              Log a call I made
            </Button>
            <Link href="/calling/lists" className={buttonSecondary}>
              Lists
            </Link>
            <Link href="/calling/start" className={buttonPrimary}>
              Start calling
            </Link>
          </div>
        }
      />

      {/* ------------------------------------------------------ date filter */}
      <Toolbar>
        <Field label="Period">
          {/* Allowed to wrap: six periods on one line is wider than a phone,
              and a filter that can only be reached by scrolling the page
              sideways is a filter nobody uses. */}
          <SegmentedControl
            className="flex-wrap"
            options={PRESETS.map((p) => ({ value: p.key, label: p.label }))}
            value={preset}
            onChange={setPreset}
          />
        </Field>
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* ----------------------------------------------- what is owed today */}
      {f && (f.overdue > 0 || f.today > 0) && (
        <Alert
          tone="warn"
          title={owed}
          action={
            <Link href="/follow-ups" className={buttonPrimary}>
              Work through them
            </Link>
          }
        >
          Someone was told they would be rung. These are those calls.
        </Alert>
      )}

      {/* ------------------------------------------------------------ tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <StatTile
          label={mine ? "Your leads" : "Leads received"}
          value={number(data?.leads.received ?? 0)}
          loading={loading}
          icon="users"
          sub={mine ? "assigned to you in this period" : "added in this period"}
        />
        <StatTile
          label={mine ? "Calls you made" : "Calls made"}
          value={number(c?.made ?? 0)}
          loading={loading}
          icon="phone"
          sub={c ? `across ${number(c.leads_touched)} ${c.leads_touched === 1 ? "person" : "people"}` : undefined}
        />
        <StatTile
          label="Got through"
          value={`${c?.connect_rate ?? 0}%`}
          loading={loading}
          accent="good"
          icon="checkCircle"
          sub={c ? `${number(c.connected)} of ${number(c.made)} calls` : undefined}
        />
        {/* Money that ARRIVED in this window. It used to be the money given by
            people who were ADDED in this window, which is a different question
            and read zero for any caller working an older list - a QR payment
            taken today against a lead from a March sheet showed nothing at
            all, on the caller's screen and the admin's alike. */}
        <StatTile
          label="Raised"
          value={currency(data?.leads.raised ?? 0)}
          loading={loading}
          accent="brand"
          icon="rupee"
          sub={
            data
              ? `${number(data.leads.donors_paid)} ${
                  data.leads.donors_paid === 1 ? "donor" : "donors"
                } paid in this period`
              : undefined
          }
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Conversion"
          value={`${data?.leads.conversion_rate ?? 0}%`}
          loading={loading}
          icon="target"
          sub={
            data
              ? `${number(data.leads.converted)} of ${number(data.leads.received)} added in this period have given`
              : "of leads added in this period"
          }
        />
        <StatTile
          label="Average call"
          value={mins(c?.avg_duration_seconds ?? null)}
          loading={loading}
          icon="clock"
          sub={
            c && c.with_duration
              ? `over the ${number(c.with_duration)} call${c.with_duration === 1 ? "" : "s"} with a length recorded`
              : "no call lengths recorded"
          }
        />
        <StatTile
          label="Pipeline"
          value={currency(data?.pipeline.value ?? 0)}
          loading={loading}
          accent="warn"
          icon="trendUp"
          sub={data ? `hoped for across ${number(data.pipeline.open_leads)} open leads` : undefined}
        />
        <StatTile
          label="Overdue"
          value={number(f?.overdue ?? 0)}
          loading={loading}
          accent={f && f.overdue > 0 ? "warn" : "default"}
          icon="bell"
          sub={f ? `${number(f.today)} due today, ${number(f.next_7_days)} this week` : undefined}
        />
      </div>

      {/* WHERE THE MONEY CAME FROM, AND HOW WELL IT IS EVIDENCED
          Raised counts every conversion — a donation the site receipted, a QR
          payment Razorpay confirmed, and cash a caller recorded at the
          counter. Only the first has a receipt row behind it in DRM. Saying so
          is better than the alternative this replaced, which was to count only
          the receipted ones and show every caller who had taken QR payments or
          cash a total of zero. */}
      {data && data.leads.raised > 0 && data.leads.raised_receipted < data.leads.raised && (
        <Alert tone="info" title="About the money">
          {currency(data.leads.raised_receipted)} of that has a receipt behind it from one of the sites. The rest —{" "}
          {currency(data.leads.raised - data.leads.raised_receipted)} across{" "}
          {number(data.leads.converted_unreceipted)}{" "}
          {data.leads.converted_unreceipted === 1 ? "donor" : "donors"} — is QR payments and cash recorded by hand.
          Real money, and it links itself to a receipt as soon as the site&apos;s own entry syncs across.
        </Alert>
      )}

      {/* The honesty note. Renders only while nothing is measured. */}
      {c && c.made > 0 && c.measured === 0 && (
        <Alert tone="info" title="About the call figures">
          Calls are placed from callers&apos; own phones and logged here afterwards, so &ldquo;got through&rdquo; and
          &ldquo;average call&rdquo; are what the caller reported — nothing is measuring them. A call nobody logs is
          not counted at all. Connecting a cloud telephony provider would make these measured instead; until then,
          read them as a record of what callers say happened.
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------- where leads are */}
        <Card>
          <CardHeader
            title="Where the leads are"
            icon="chart"
            subtitle={mine ? "Your leads, by stage" : "Every lead, by stage"}
          />
          {!data?.by_status.length ? (
            <EmptyState
              icon="users"
              title={mine ? "No leads yet" : "No leads yet"}
              message={
                mine
                  ? "Nothing has been assigned to you yet. Ask for a list, or open Lists to see what is going."
                  : "Add a list or pull some donors in to get started."
              }
            />
          ) : (
            <ul className="space-y-2.5">
              {data.by_status.map((s) => (
                <li key={s.status}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate text-ink-soft">{s.label}</span>
                    <span className="tabular-nums font-medium text-ink">{number(s.n)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-sunken">
                    <div
                      className="h-full rounded-pill bg-brand-600"
                      style={{ width: `${(s.n / maxStatus) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------ where they came from */}
        <Card>
          <CardHeader
            title="Where they came from"
            icon="tag"
            subtitle={
              mine
                ? "Your leads in this period, and how many gave"
                : "Leads added in this period, and how many gave"
            }
          />
          {!data?.by_source.length ? (
            <EmptyState icon="inbox" title="Nothing in this period" message="Try a wider date range." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {data.by_source.map((s) => (
                <li key={s.source} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-sm text-ink-soft">{SOURCE_LABELS[s.source] ?? s.source}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="tabular-nums text-ink">{number(s.n)}</span>
                    {s.converted > 0 && <Badge tone="good">{s.converted} gave</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------- money by QR */}
        {/* These QRs are shared on calls and nowhere else, so every rupee
            through one was raised on the phone. That makes this the truest
            picture of what the calling brought in - and unlike the figures
            above it does not wait on anybody attributing a payment first. */}
        {!!data?.by_qr.filter((q) => q.payments > 0).length && (
          <Card className="lg:col-span-2">
            <CardHeader
              title="Raised through each QR"
              icon="qr"
              subtitle="Money that arrived in this period, by the QR it came through"
              action={
                <Link
                  href="/calling/payments"
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  Every payment
                  <Icon name="arrowRight" size={12} />
                </Link>
              }
            />
            <ul className="divide-y divide-line-soft">
              {data.by_qr
                .filter((q) => q.payments > 0)
                .map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">{q.label}</span>
                      <span className="block text-2xs text-ink-muted">
                        {[q.purpose, q.owner_name ?? "the temple's"].filter(Boolean).join(" · ")}
                        {q.unattributed > 0 && (
                          <span className="text-warn">
                            {" "}
                            · {number(q.unattributed)} not yet matched to a donor
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-right">
                      <span className="block tabular-nums font-medium text-ink">{currency(q.raised)}</span>
                      <span className="block text-2xs text-ink-muted">
                        {number(q.payments)} payment{q.payments === 1 ? "" : "s"}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-muted">
              {currency(data.qr.through_qrs)} through QRs in this period
              {data.qr.unattributed > 0 && (
                <>
                  {" — "}
                  {number(data.qr.unattributed)} payment{data.qr.unattributed === 1 ? " is" : "s are"} still
                  waiting to be matched to a donor, which is the only part of this the reports above cannot see.
                </>
              )}
            </p>
          </Card>
        )}

        {/* --------------------------------------------------- QRs and money */}
        {/* Shown to everyone, because "was that QR ever paid" is the one
            question the rest of this screen cannot answer. On a caller's
            screen it counts only the QRs they sent. */}
        <Card className={mine ? "lg:col-span-2" : ""}>
          <CardHeader
            title={mine ? "QRs you sent" : "QRs sent"}
            icon="qr"
            subtitle="Shared during calls, and what came back"
            action={
              <Link
                href="/calling/payments"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                QR payments
                <Icon name="arrowRight" size={12} />
              </Link>
            }
          />
          {!data?.qr.shared ? (
            <EmptyState
              icon="qr"
              title="No QRs sent in this period"
              message="During a call, pick a QR and press send — the payment finds its way back here on its own."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="Sent" value={number(data.qr.shared)} icon="upload" sub="during calls in this period" />
              <StatTile
                label="Paid"
                value={number(data.qr.paid)}
                accent="good"
                icon="rupee"
                sub={`${currency(data.qr.raised)} in all`}
              />
              <StatTile
                label="Still waiting"
                value={number(data.qr.awaiting)}
                accent={data.qr.awaiting > 0 ? "warn" : "default"}
                icon="clock"
                sub="sent in the last 7 days, no payment yet"
              />
            </div>
          )}
        </Card>

        {/* ------------------------------------------------------ on the phone */}
        {/* Withheld from callers, and not merely hidden: the server does not
            send it to them. A leaderboard of one person is not a leaderboard,
            and a caller has no business reading their colleagues' numbers. */}
        {!mine && (
        <Card className="lg:col-span-2">
          <CardHeader
            title="On the phone today"
            icon="users"
            subtitle="Calls logged since midnight — not affected by the date filter above"
            action={
              <Link
                href="/calling/reports"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                Full caller report
                <Icon name="arrowRight" size={12} />
              </Link>
            }
          />
          {!data?.callers_today.length ? (
            <EmptyState icon="phone" title="No calls logged today" message="Nothing has been recorded since midnight." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {data.callers_today.map((u) => (
                <li key={u.id} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="truncate text-sm text-ink-soft">{u.name}</span>
                  <span className="whitespace-nowrap text-sm tabular-nums text-ink-muted">
                    {number(u.calls)} call{u.calls === 1 ? "" : "s"}
                    <span className="text-ink-faint"> · {number(u.connected)} got through</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        )}
      </div>

      {outside && (
        <OutsideCallDialog
          onClose={() => setOutside(false)}
          onDone={async () => {
            setOutside(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * A call that did not come out of the queue.
 *
 * DRM assumed every call starts on the calling screen. Real days are not like
 * that: somebody rings the temple and gets rung back from a personal phone, a
 * devotee passes on a number, a donor from last year is called directly. None
 * of that was recorded anywhere, so the call never happened as far as DRM was
 * concerned - and if money followed through a QR, there was no share for it to
 * match against.
 *
 * One form records the lot. It finds the person by number or adds them, logs
 * the call against your name, and hands you the lead so you can send them a QR
 * straight afterwards.
 */
function OutsideCallDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> | void }) {
  const [dispositions, setDispositions] = useState<{ slug: string; label: string; counts_connected: boolean }[]>([]);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; name: string | null } | null>(null);

  useEffect(() => {
    apiClient
      .get<{ dispositions: typeof dispositions }>("/api/crm/config")
      .then((d) => {
        setDispositions(d.dispositions);
        setOutcome((o) => o || d.dispositions[0]?.slug || "");
      })
      .catch(() => undefined);
  }, []);

  // Once it is recorded, the useful next step is almost always the QR.
  if (done) {
    return (
      <Modal
        title="Recorded"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Link href={`/leads/${done.id}`} className={buttonPrimary}>
              Open them — send a QR
            </Link>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          The call is on {done.name || "their"} record, against your name.
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      title="Log a call I made"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={busy || phone.replace(/\D/g, "").length < 10 || !outcome}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await apiClient.post<{ lead: { id: string; name: string | null } }>(
                  "/api/crm/calls/outside",
                  {
                    phone,
                    name: name.trim() || undefined,
                    disposition: outcome,
                    note: note.trim() || undefined,
                    donated_amount: amount ? Number(amount) : undefined,
                  }
                );
                await onDone();
                setDone({ id: r.lead.id, name: r.lead.name });
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not record that call");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Record it"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-4 text-sm text-ink-muted">
        For a call you made from your own phone, or to somebody who was not in a list. DRM finds them by number, or
        adds them, and records the call against you.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Their number" htmlFor="outside-phone" required>
          <Input
            id="outside-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
        <Field label="Their name" htmlFor="outside-name">
          <Input
            id="outside-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="If you caught it"
          />
        </Field>
        <Field label="What came of it" required>
          <Select
            value={outcome}
            onChange={setOutcome}
            ariaLabel="What came of it"
            options={dispositions.map((d) => ({ value: d.slug, label: d.label }))}
          />
        </Field>
        <Field label="If they gave, how much" htmlFor="outside-amount">
          <Input
            id="outside-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>
        <Field label="What was said" htmlFor="outside-note" className="sm:col-span-2">
          <Textarea id="outside-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
