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
import { Badge, Card, CardHeader, EmptyState, Modal, PageHeader, Select, StatTile, buttonPrimary, buttonSecondary, inputClass } from "@/components/ui";

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

  return (
    <div>
      <PageHeader
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
            <button onClick={() => setOutside(true)} className={buttonSecondary}>
              Log a call I made
            </button>
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
      <div className="mb-5 flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPreset(p.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium border transition-colors ${
              preset === p.key
                ? "border-[var(--accent)] bg-[var(--accent-wash)] text-[var(--accent)]"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      {/* ----------------------------------------------- what is owed today */}
      {f && (f.overdue > 0 || f.today > 0) && (
        <Card className="mb-5 border-amber-200 bg-amber-50/60">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-amber-900">
                {f.overdue > 0 && (
                  <>
                    {number(f.overdue)} callback{f.overdue === 1 ? "" : "s"} overdue
                    {f.today > 0 && " · "}
                  </>
                )}
                {f.today > 0 && <>{number(f.today)} due today</>}
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                Someone was told they would be rung. These are those calls.
              </p>
            </div>
            <Link href="/follow-ups" className={buttonPrimary}>
              Work through them
            </Link>
          </div>
        </Card>
      )}

      {/* ------------------------------------------------------------ tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <StatTile
          label={mine ? "Your leads" : "Leads received"}
          value={loading ? "—" : number(data?.leads.received ?? 0)}
          sub={mine ? "assigned to you in this period" : "added in this period"}
        />
        <StatTile
          label={mine ? "Calls you made" : "Calls made"}
          value={loading ? "—" : number(c?.made ?? 0)}
          sub={c ? `across ${number(c.leads_touched)} ${c.leads_touched === 1 ? "person" : "people"}` : undefined}
        />
        <StatTile
          label="Got through"
          value={loading ? "—" : `${c?.connect_rate ?? 0}%`}
          accent="good"
          sub={c ? `${number(c.connected)} of ${number(c.made)} calls` : undefined}
        />
        {/* Money that ARRIVED in this window. It used to be the money given by
            people who were ADDED in this window, which is a different question
            and read zero for any caller working an older list - a QR payment
            taken today against a lead from a March sheet showed nothing at
            all, on the caller's screen and the admin's alike. */}
        <StatTile
          label="Raised"
          value={loading ? "—" : currency(data?.leads.raised ?? 0)}
          accent="brand"
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
          value={loading ? "—" : `${data?.leads.conversion_rate ?? 0}%`}
          sub={
            data
              ? `${number(data.leads.converted)} of ${number(data.leads.received)} added in this period have given`
              : "of leads added in this period"
          }
        />
        <StatTile
          label="Average call"
          value={loading ? "—" : mins(c?.avg_duration_seconds ?? null)}
          sub={
            c && c.with_duration
              ? `over the ${number(c.with_duration)} call${c.with_duration === 1 ? "" : "s"} with a length recorded`
              : "no call lengths recorded"
          }
        />
        <StatTile
          label="Pipeline"
          value={loading ? "—" : currency(data?.pipeline.value ?? 0)}
          accent="warn"
          sub={data ? `hoped for across ${number(data.pipeline.open_leads)} open leads` : undefined}
        />
        <StatTile
          label="Overdue"
          value={loading ? "—" : number(f?.overdue ?? 0)}
          accent={f && f.overdue > 0 ? "warn" : "default"}
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
        <p className="mb-5 rounded-lg bg-slate-50 px-4 py-3 text-xs text-slate-500">
          <strong className="font-medium text-slate-700">About the money.</strong>{" "}
          {currency(data.leads.raised_receipted)} of that has a receipt behind it from one of the sites. The rest —{" "}
          {currency(data.leads.raised - data.leads.raised_receipted)} across{" "}
          {number(data.leads.converted_unreceipted)}{" "}
          {data.leads.converted_unreceipted === 1 ? "donor" : "donors"} — is QR payments and cash recorded by hand.
          Real money, and it links itself to a receipt as soon as the site&apos;s own entry syncs across.
        </p>
      )}

      {/* The honesty note. Renders only while nothing is measured. */}
      {c && c.made > 0 && c.measured === 0 && (
        <p className="mb-6 text-xs text-slate-500 rounded-lg bg-slate-50 px-4 py-3">
          <strong className="font-medium text-slate-700">About the call figures.</strong> Calls are placed from
          callers&apos; own phones and logged here afterwards, so &ldquo;got through&rdquo; and &ldquo;average
          call&rdquo; are what the caller reported — nothing is measuring them. A call nobody logs is not counted at
          all. Connecting a cloud telephony provider would make these measured instead; until then, read them as a
          record of what callers say happened.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------- where leads are */}
        <Card>
          <CardHeader title="Where the leads are" subtitle={mine ? "Your leads, by stage" : "Every lead, by stage"} />
          {!data?.by_status.length ? (
            <EmptyState
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
                    <span className="text-slate-700 truncate">{s.label}</span>
                    <span className="tabular-nums font-medium text-slate-900">{number(s.n)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[var(--accent)]"
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
            subtitle={
              mine
                ? "Your leads in this period, and how many gave"
                : "Leads added in this period, and how many gave"
            }
          />
          {!data?.by_source.length ? (
            <EmptyState title="Nothing in this period" message="Try a wider date range." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.by_source.map((s) => (
                <li key={s.source} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700">{SOURCE_LABELS[s.source] ?? s.source}</span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="tabular-nums text-slate-900">{number(s.n)}</span>
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
              subtitle="Money that arrived in this period, by the QR it came through"
              action={
                <Link href="/calling/payments" className="text-xs text-[var(--accent)] hover:underline">
                  Every payment →
                </Link>
              }
            />
            <ul className="divide-y divide-slate-100">
              {data.by_qr
                .filter((q) => q.payments > 0)
                .map((q) => (
                  <li key={q.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{q.label}</span>
                      <span className="block text-[11px] text-slate-500">
                        {[q.purpose, q.owner_name ?? "the temple's"].filter(Boolean).join(" · ")}
                        {q.unattributed > 0 && (
                          <span className="text-amber-700">
                            {" "}
                            · {number(q.unattributed)} not yet matched to a donor
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-right">
                      <span className="block tabular-nums font-medium text-slate-900">{currency(q.raised)}</span>
                      <span className="block text-[11px] text-slate-500">
                        {number(q.payments)} payment{q.payments === 1 ? "" : "s"}
                      </span>
                    </span>
                  </li>
                ))}
            </ul>
            <p className="mt-3 border-t border-[var(--line-soft)] pt-3 text-xs text-slate-500">
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
            subtitle="Shared during calls, and what came back"
            action={
              <Link href="/calling/payments" className="text-xs text-[var(--accent)] hover:underline">
                QR payments →
              </Link>
            }
          />
          {!data?.qr.shared ? (
            <EmptyState
              title="No QRs sent in this period"
              message="During a call, pick a QR and press send — the payment finds its way back here on its own."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="Sent" value={number(data.qr.shared)} sub="during calls in this period" />
              <StatTile
                label="Paid"
                value={number(data.qr.paid)}
                accent="good"
                sub={`${currency(data.qr.raised)} in all`}
              />
              <StatTile
                label="Still waiting"
                value={number(data.qr.awaiting)}
                accent={data.qr.awaiting > 0 ? "warn" : "default"}
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
            subtitle="Calls logged since midnight — not affected by the date filter above"
            action={
              <Link href="/calling/reports" className="text-xs text-[var(--accent)] hover:underline">
                Full caller report →
              </Link>
            }
          />
          {!data?.callers_today.length ? (
            <EmptyState title="No calls logged today" message="Nothing has been recorded since midnight." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.callers_today.map((u) => (
                <li key={u.id} className="py-2.5 flex items-center justify-between gap-3">
                  <span className="text-sm text-slate-700 truncate">{u.name}</span>
                  <span className="text-sm text-slate-600 tabular-nums whitespace-nowrap">
                    {number(u.calls)} call{u.calls === 1 ? "" : "s"}
                    <span className="text-slate-400"> · {number(u.connected)} got through</span>
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
      <Modal title="Recorded" onClose={onClose}>
        <p className="text-sm text-slate-700">
          The call is on {done.name || "their"} record, against your name.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className={buttonSecondary}>
            Close
          </button>
          <Link href={`/leads/${done.id}`} className={buttonPrimary}>
            Open them — send a QR
          </Link>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Log a call I made" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      <p className="mb-4 text-sm text-slate-600">
        For a call you made from your own phone, or to somebody who was not in a list. DRM finds them by number, or
        adds them, and records the call against you.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          Their number <span className="text-red-600">*</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Their name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="If you caught it"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          What came of it <span className="text-red-600">*</span>
          <Select
            value={outcome}
            onChange={setOutcome}
            className="mt-1 w-full"
            options={dispositions.map((d) => ({ value: d.slug, label: d.label }))}
          />
        </label>
        <label className="text-xs text-slate-500">
          If they gave, how much
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
        <label className="text-xs text-slate-500 sm:col-span-2">
          What was said
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>
          Cancel
        </button>
        <button
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
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Record it"}
        </button>
      </div>
    </Modal>
  );
}
