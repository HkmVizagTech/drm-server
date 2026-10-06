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

import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
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

type CreditKind = "qr" | "link" | "lead" | "offline" | "manual";

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
  /**
   * EVERY RUPEE ON THIS SCREEN COMES FROM HERE, and nothing else may be summed
   * into a money figure.
   *
   * It sits apart from `leads` because it is no longer a fact about leads: a
   * QR payment, a link donation and cash a caller banked are all credits and
   * none of them need a lead to exist. `leads.raised` is still sent as a
   * mirror of `money.raised` for anything that has not moved over yet - this
   * screen has, so it reads `money`.
   */
  money: {
    raised: number;
    credits: number;
    /** Watched by a system, or ticked off against the bank statement by a person. */
    verified: number;
    /** Reported by a caller and not yet reconciled. Counted, and said so. */
    awaiting_verification: number;
    by_kind: Record<CreditKind, number>;
  };
  leads: {
    received: number;
    converted: number;
    conversion_rate: number;
    /** A temporary mirror of money.raised. Do not read it; read money.raised. */
    raised: number;
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
    awaiting: number;
    /** QR money credited to a named caller — the same figure as money.by_kind.qr. */
    credited: number;
    /** Every rupee through a QR in this period, attributed or not. A SUPERSET of `credited`. */
    through_qrs: number;
    /** through_qrs minus credited: QR money nobody has been credited with yet. */
    not_credited: number;
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

// What each kind of credit actually is, in the words a caller would use.
// "You raised ₹40,000" is not actionable; "₹31,000 through your QR, ₹9,000 you
// banked yourself" is, and the old model could not express it at all - it had
// one column on leads and no record of where the money had come from.
//
// Duplicated from the earnings screen rather than shared, because a page
// module is not a place to import constants from; if a third screen needs
// these they belong in lib.
const CREDIT_KINDS: { key: CreditKind; label: string }[] = [
  { key: "qr", label: "QR payments" },
  { key: "link", label: "Donation links" },
  { key: "lead", label: "After a call" },
  { key: "offline", label: "Collected by PhonePe" },
  { key: "manual", label: "Added by hand" },
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

// The period lives in the URL, so opening a tile and pressing Back returns
// to the same period. useSearchParams needs a Suspense boundary.
export default function CallingDashboardPage() {
  return (
    <Suspense fallback={null}>
      <CallingDashboard />
    </Suspense>
  );
}

function CallingDashboard() {
  const sp = useSearchParams();
  const router = useRouter();
  const preset = PRESETS.some((p) => p.key === sp.get("period")) ? (sp.get("period") as string) : "month";
  const setPreset = (v: string) => router.replace(v === "month" ? "/calling" : `/calling?period=${v}`, { scroll: false });
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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
  const { user } = useAuth();

  /**
   * WHERE EACH NUMBER OPENS
   * Every figure here is a question somebody asks next - "which ones?" - so
   * each tile opens the list it counted: the same people, the same dates,
   * the same "yours". A number you cannot open is one you have to take on
   * trust, and this screen is read by the people it measures.
   */
  const r = data?.range;
  const leadsLink = (extra: Record<string, string>) => {
    const p = new URLSearchParams(extra);
    if (mine && user?.id) p.set("assigned_to", user.id);
    return `/leads?${p}`;
  };
  const inWindow: Record<string, string> = r && preset !== "all" ? { added_from: r.from, added_to: r.to } : {};
  const callsLink = (extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(
      preset === "today" ? { period: "today" } : preset === "all" ? { period: "all" } : r ? { from: r.from, to: r.to } : {}
    );
    for (const [k, v] of Object.entries(extra)) p.set(k, v);
    return `/calling/calls?${p}`;
  };
  const earningsLink = (kind?: string) => `/calling/earnings?preset=${preset}${kind ? `&kind=${kind}` : ""}`;

  // Built as one string rather than nested fragments so the warning can be the
  // Alert's own title: the banner reads as one sentence either way, and the
  // "·" only appears when both halves are there.
  const owed = f
    ? [
        f.overdue > 0 ? `${number(f.overdue)} follow-up${f.overdue === 1 ? "" : "s"} overdue` : null,
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
            ? "Your leads and calls"
            : "Calls to donors"
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
              Open follow-ups
            </Link>
          }
        />
      )}

      {/* ------------------------------------------------------------ tiles */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-5">
        <StatTile
          label={mine ? "Your leads" : "Leads received"}
          value={number(data?.leads.received ?? 0)}
          loading={loading}
          icon="users"
          sub={mine ? "Given to you" : "Added"}
          href={leadsLink(inWindow)}
        />
        <StatTile
          label={mine ? "Calls you made" : "Calls made"}
          value={number(c?.made ?? 0)}
          loading={loading}
          icon="phone"
          sub={c ? `to ${number(c.leads_touched)} ${c.leads_touched === 1 ? "person" : "people"}` : undefined}
          href={callsLink()}
        />
        <StatTile
          label="Answered"
          value={`${c?.connect_rate ?? 0}%`}
          loading={loading}
          accent="good"
          icon="checkCircle"
          sub={c ? `${number(c.connected)} of ${number(c.made)} calls` : undefined}
          href={callsLink({ connected: "true" })}
        />
        {/* Money that ARRIVED in this window. It used to be the money given by
            people who were ADDED in this window, which is a different question
            and read zero for any caller working an older list - a QR payment
            taken today against a lead from a March sheet showed nothing at
            all, on the caller's screen and the admin's alike.
            Read from `money`, not from leads.raised: that field is a mirror
            kept only until every screen has moved over, and reaching for it is
            how the next tile ends up summing a different table again. */}
        <StatTile
          label="Money raised"
          value={currency(data?.money.raised ?? 0)}
          loading={loading}
          accent="brand"
          icon="rupee"
          sub={
            data
              ? `${number(data.leads.donors_paid)} ${
                  data.leads.donors_paid === 1 ? "donor" : "donors"
                } paid`
              : undefined
          }
          href={earningsLink()}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
        <StatTile
          label="Gave"
          value={`${data?.leads.conversion_rate ?? 0}%`}
          loading={loading}
          icon="target"
          sub={
            data
              ? `${number(data.leads.converted)} of ${number(data.leads.received)} leads`
              : "of leads"
          }
          href={leadsLink({ ...inWindow, converted_from: "1970-01-01" })}
        />
        <StatTile
          label="Average call"
          value={mins(c?.avg_duration_seconds ?? null)}
          loading={loading}
          icon="clock"
          sub={
            c && c.with_duration
              ? `from ${number(c.with_duration)} call${c.with_duration === 1 ? "" : "s"}`
              : "No call times yet"
          }
          href={callsLink()}
        />
        <StatTile
          label="Hoped for"
          value={currency(data?.pipeline.value ?? 0)}
          loading={loading}
          accent="warn"
          icon="trendUp"
          sub={data ? `from ${number(data.pipeline.open_leads)} open leads` : undefined}
          href={leadsLink({ open: "true" })}
        />
        <StatTile
          label="Overdue"
          value={number(f?.overdue ?? 0)}
          loading={loading}
          accent={f && f.overdue > 0 ? "warn" : "default"}
          icon="bell"
          sub={f ? `${number(f.today)} due today, ${number(f.next_7_days)} this week` : undefined}
          href={leadsLink({ due: "overdue" })}
        />
      </div>

      {/* WHERE THE MONEY CAME FROM
          One total answers "how much" and nothing else. This answers the
          question the person reading it actually has next, which is "through
          what" - and it is only possible at all because every rupee is now a
          credit row carrying its own kind. The figure this card replaced split
          the money by whether a receipt had synced across yet, which is a fact
          about the websites rather than about the calling. */}
      {data && data.money.raised > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="How it came in"
            icon="rupee"
            subtitle={mine ? "Your total, by type" : "By type"}
            action={
              <Link
                href="/calling/earnings"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                See all
                <Icon name="arrowRight" size={12} />
              </Link>
            }
          />
          <ul className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {CREDIT_KINDS.map((k) => (
              <li key={k.key}>
                <Link
                  href={earningsLink(k.key)}
                  className="block rounded-control bg-sunken px-3 py-2.5 transition-colors hover:bg-brand-50 hover:ring-1 hover:ring-brand-200"
                >
                  <span className="block text-2xs font-medium uppercase tracking-wide text-ink-muted">{k.label}</span>
                  <span className="mt-0.5 block truncate text-base font-semibold tabular-nums text-ink">
                    {currency(data.money.by_kind[k.key])}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-muted">
            {currency(data.money.verified)} checked
            {data.money.awaiting_verification > 0 && (
              <>
                {" · "}
                <span className="font-medium text-warn">
                  {currency(data.money.awaiting_verification)} not checked yet
                </span>
              </>
            )}
            {" · "}
            {number(data.money.credits)} entr{data.money.credits === 1 ? "y" : "ies"}
          </p>
        </Card>
      )}

      {/* WHY THIS IS NOT FOLDED INTO THE TOTAL
          Offline money is a caller's own report: it went to a PhonePe or UPI
          number, so nothing observed it and nobody can tell from one "raised"
          figure which part of it a machine saw arrive. It is counted either
          way - the alternative this replaced showed every caller who worked
          that way a total of zero - but the screen says which part is which,
          in words, because "awaiting" looks like an accusation to the person
          whose money it is and it is not one. */}
      {data && data.money.awaiting_verification > 0 && (
        <Alert tone="info">
          {currency(data.money.awaiting_verification)} paid by PhonePe or UPI is not checked yet.{" "}
          <Link href="/calling/collected" className="font-medium text-brand-700 hover:underline">
            Collected by PhonePe
          </Link>
        </Alert>
      )}

      {/* The honesty note. Renders only while nothing is measured. */}
      {c && c.made > 0 && c.measured === 0 && (
        <Alert tone="info">Call figures are what callers logged.</Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ------------------------------------------------- where leads are */}
        <Card>
          <CardHeader
            title="Leads by stage"
            icon="chart"
            subtitle={mine ? "Your leads" : "All leads"}
          />
          {!data?.by_status.length ? (
            <EmptyState
              icon="users"
              title={mine ? "No leads yet" : "No leads yet"}
              message={
                mine
                  ? "Ask your admin for a list."
                  : "Add a list to start."
              }
            />
          ) : (
            <ul className="space-y-1">
              {data.by_status.map((s) => (
                <li key={s.status}>
                  <Link
                    href={leadsLink({ status: s.status })}
                    className="group -mx-2 block rounded-control px-2 py-1 transition-colors hover:bg-brand-50"
                  >
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="truncate text-ink-soft group-hover:text-brand-800">{s.label}</span>
                      <span className="flex items-center gap-1.5 tabular-nums font-medium text-ink">
                        {number(s.n)}
                        <Icon name="chevronRight" size={13} className="text-ink-faint" />
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-sunken">
                      <div
                        className="h-full rounded-pill bg-brand-600"
                        style={{ width: `${(s.n / maxStatus) * 100}%` }}
                      />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------ where they came from */}
        <Card>
          <CardHeader
            title="Lead sources"
            icon="tag"
            subtitle="And how many gave"
          />
          {!data?.by_source.length ? (
            <EmptyState icon="inbox" title="Nothing in this period" message="Try a longer period." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {data.by_source.map((s) => (
                <li key={s.source}>
                  <Link
                    href={leadsLink({ ...inWindow, source: s.source })}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-control px-2 py-2.5 transition-colors hover:bg-brand-50"
                  >
                    <span className="text-sm text-ink-soft">{SOURCE_LABELS[s.source] ?? s.source}</span>
                    <span className="flex items-center gap-2 text-sm">
                      <span className="tabular-nums text-ink">{number(s.n)}</span>
                      {s.converted > 0 && <Badge tone="good">{s.converted} gave</Badge>}
                      <Icon name="chevronRight" size={13} className="text-ink-faint" />
                    </span>
                  </Link>
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
              title="Money by QR"
              icon="qr"
              subtitle="Paid in this period"
              action={
                <Link
                  href="/calling/payments"
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
                >
                  See all
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
                        {[q.purpose, q.owner_name ?? "Temple"].filter(Boolean).join(" · ")}
                        {q.unattributed > 0 && (
                          <span className="text-warn">
                            {" "}
                            · {number(q.unattributed)} not linked yet
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
            {/* through_qrs is a SUPERSET of the credited figure, not a second
                pile of money — adding the two would count the same payments
                twice. The gap between them has a name on the server
                (`not_credited`) and is printed here rather than left for the
                reader to subtract in their head and wonder which is wrong. */}
            <p className="mt-3 border-t border-line-soft pt-3 text-xs text-ink-muted">
              {currency(data.qr.through_qrs)} through QRs. {currency(data.qr.credited)} counted for callers
              {data.qr.not_credited > 0 && (
                <>
                  {" · "}
                  <span className="text-warn">{currency(data.qr.not_credited)}</span> not counted yet
                </>
              )}
              .
              {data.qr.unattributed > 0 && (
                <>
                  {" "}
                  {number(data.qr.unattributed)} payment{data.qr.unattributed === 1 ? "" : "s"} not linked yet.
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
            subtitle="Sent on calls"
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
              message="Send a QR during a call."
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile label="Sent" value={number(data.qr.shared)} icon="upload" sub="On calls" href="/calling/payments?scope=all" />
              {/* `credited`, not a second sum of its own: this is literally
                  money.by_kind.qr, so the tile and the breakdown above cannot
                  come to different answers about the same QR payments. */}
              <StatTile
                label="Paid"
                value={number(data.qr.paid)}
                accent="good"
                icon="rupee"
                sub={`${currency(data.qr.credited)} counted`}
                href="/calling/payments?scope=all"
              />
              <StatTile
                label="Still waiting"
                value={number(data.qr.awaiting)}
                accent={data.qr.awaiting > 0 ? "warn" : "default"}
                icon="clock"
                sub="Last 7 days, not paid"
                href="/calling/payments"
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
            title="Calls today"
            icon="users"
            subtitle="Since midnight"
            action={
              <Link
                href="/calling/reports"
                className="inline-flex items-center gap-1 text-xs font-medium text-brand-700 hover:underline"
              >
                Caller report
                <Icon name="arrowRight" size={12} />
              </Link>
            }
          />
          {!data?.callers_today.length ? (
            <EmptyState icon="phone" title="No calls today" message="Calls you log show here." />
          ) : (
            <ul className="divide-y divide-line-soft">
              {data.callers_today.map((u) => (
                <li key={u.id}>
                  <Link
                    href={`/calling/calls?period=today&user_id=${u.id}`}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-control px-2 py-2.5 transition-colors hover:bg-brand-50"
                  >
                    <span className="truncate text-sm text-ink-soft">{u.name}</span>
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-sm tabular-nums text-ink-muted">
                      {number(u.calls)} call{u.calls === 1 ? "" : "s"}
                      <span className="text-ink-faint"> · {number(u.connected)} answered</span>
                      <Icon name="chevronRight" size={13} className="text-ink-faint" />
                    </span>
                  </Link>
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
        title="Saved"
        onClose={onClose}
        footer={
          <>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Link href={`/leads/${done.id}`} className={buttonPrimary}>
              Send a QR
            </Link>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Call saved for {done.name || "this donor"}.
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
                setError(e instanceof Error ? e.message : "Could not save. Try again.");
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}


      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mobile Number" htmlFor="outside-phone" required>
          <Input
            id="outside-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, ""))}
            placeholder="98480 12345"
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
        <Field label="Donor Name" htmlFor="outside-name">
          <Input
            id="outside-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Optional"
          />
        </Field>
        <Field label="Call result" required>
          <Select
            value={outcome}
            onChange={setOutcome}
            ariaLabel="Call result"
            options={dispositions.map((d) => ({ value: d.slug, label: d.label }))}
          />
        </Field>
        <Field label="Amount" htmlFor="outside-amount">
          <Input
            id="outside-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            placeholder="Optional"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>
        <Field label="Note" htmlFor="outside-note" className="sm:col-span-2">
          <Textarea id="outside-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </Field>
      </div>
    </Modal>
  );
}
