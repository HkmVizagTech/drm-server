"use client";

// What came in under a caller.
//
// WHY THIS SCREEN EXISTS
// "How much has this caller raised" used to be answered by three different
// queries over three different tables, which gave three different numbers -
// and because they were live joins on leads.assigned_to, reassigning a lead
// rewrote somebody's past months. There is one caller_credits ledger now: one
// immutable row per credited amount, written at the moment the attribution was
// decided, carrying the evidence that earned it. This is that ledger, read.
//
// So the screen is not a summary. It is the list a figure can be checked
// against, line by line, which is the only form in which a money figure is
// worth anything to the person being measured by it or to the person asking
// them about it.
//
// THE ONE DISTINCTION THIS SCREEN MUST NOT BLUR
// Four of the five kinds record something a machine watched arrive: a Razorpay
// payment, a donation synced from one of the sites. The fifth - offline - is
// money a caller took on a PhonePe or UPI number and wrote down afterwards.
// Nothing observed it, so it waits for an admin to find it on the bank
// statement. Both are counted here, and the screen says which is which on
// every row. Awaiting a check means nobody has looked yet; it does not mean
// anybody doubts it.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, dateTime, number, relativeDate, shortDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Pagination,
  SegmentedControl,
  Select,
  SkeletonRows,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
} from "@/components/ui";
import { ExportButton } from "@/components/export-button";

type CreditKind = "qr" | "link" | "lead" | "offline" | "manual";

/**
 * Shaped field-for-field like the `money` block the dashboard sends, because
 * the server builds both from the same aggregate. If a field is added there it
 * belongs here under the same name - two readings of one set of words is how
 * two screens start disagreeing about what "verified" means.
 */
interface CreditTotals {
  raised: number;
  credits: number;
  verified: number;
  awaiting_verification: number;
  by_kind: Record<CreditKind, number>;
}

interface Credit {
  id: string;
  amount: number;
  kind: CreditKind;
  occurred_at: string;
  note: string | null;
  verified_at: string | null;
  verified: boolean;
  user_id: string;
  caller_name: string;
  /** Whichever of these four is set is this credit's evidence; the kind says which. */
  payment_reference: string | null;
  receipt_number: string | null;
  lead_name: string | null;
  link_label: string | null;
}

interface CreditsResponse {
  range: { from: string; to: string; label: string };
  /**
   * Whose ledger this is, decided by the server from the role rather than by
   * anything this page asks for. A caller gets "mine" however the URL is
   * edited, so the heading can never claim one thing while the rows are the
   * other.
   */
  scope: "mine" | "team";
  filters: { user_id: string | null; kind: CreditKind | null; verified: string | null };
  totals: CreditTotals;
  credits: Credit[];
  total: number;
  page: number;
  limit: number;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "week", label: "7 days" },
  { value: "month", label: "This month" },
  { value: "quarter", label: "90 days" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
];

// What each kind actually is, in the words a caller would use. "₹40,000" is
// not actionable; "₹31,000 through your QR, ₹9,000 you banked yourself" is.
const KINDS: { key: CreditKind; label: string; hint: string }[] = [
  { key: "qr", label: "QR payments", hint: "Paid through your QR" },
  { key: "link", label: "Donation links", hint: "Paid through your link" },
  { key: "lead", label: "After a call", hint: "Your lead gave" },
  { key: "offline", label: "Collected by PhonePe", hint: "Paid to a PhonePe or UPI number" },
  { key: "manual", label: "Added by hand", hint: "Added by an admin" },
];

const KIND_LABEL: Record<CreditKind, string> = {
  qr: "QR payment",
  link: "Donation link",
  lead: "After a call",
  offline: "Collected by PhonePe",
  manual: "Added by hand",
};

// Only the roles that can hold a credit. The config endpoint returns every
// account, and a selector listing the prasadam coordinator offers a choice
// whose only possible answer is an empty table.
const CREDITABLE = ["caller", "admin", "accountant"];

const LIMIT = 50;

export default function CallerEarningsPage() {
  const { user } = useAuth();
  const [preset, setPreset] = useState("month");
  const [kind, setKind] = useState("");
  const [verified, setVerified] = useState("");
  const [userId, setUserId] = useState("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<CreditsResponse | null>(null);
  const [callers, setCallers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The selector is an admin's tool. A caller is narrowed to themselves
  // server-side whatever the query string says, so offering them a list of
  // colleagues would be offering a control that cannot do anything.
  const canChooseCaller = !!user && user.role !== "caller";

  /**
   * The filters, described once.
   *
   * The list request and the download both read this one value. A second
   * builder drifts from the one on screen, and a file covering a wider period
   * than the screen it was taken from is worse than no file - somebody sends
   * it to the office, who act on it.
   */
  const filterParams = useCallback(() => {
    const p = new URLSearchParams({ preset, page: String(page), limit: String(LIMIT) });
    if (kind) p.set("kind", kind);
    if (verified) p.set("verified", verified);
    if (userId) p.set("user_id", userId);
    return p;
  }, [preset, kind, verified, userId, page]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiClient.get<CreditsResponse>(`/api/crm/reports/credits?${filterParams()}`));
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
      // Swallowed on purpose: the selector is a convenience and the ledger
      // below is the screen. Failing the whole page because one dropdown could
      // not be populated would hide the money over a list of names.
      .then((c) => setCallers(c.users.filter((u) => CREDITABLE.includes(u.role))))
      .catch(() => undefined);
  }, [canChooseCaller]);

  // Any filter change goes back to page one. Holding page seven while the
  // filter narrows to four rows shows an empty table, which reads as a screen
  // that failed rather than as a filter that worked.
  const refilter = (apply: () => void) => {
    apply();
    setPage(1);
  };

  const t = data?.totals;
  const mine = data?.scope === "mine";
  const chosen = callers.find((c) => c.id === userId);
  const activeFilters = [kind, verified, userId].filter(Boolean).length;
  const cols = canChooseCaller ? 7 : 6;
  // The widest kind figure sets the bar scale, so the breakdown below reads as
  // a comparison between kinds rather than against the total - which would
  // leave every bar but one too short to see.
  const maxKind = Math.max(1, ...KINDS.map((k) => t?.by_kind[k.key] ?? 0));

  return (
    <div>
      {/* The heading names the caller once one is picked, rather than saying
          "each caller": an admin who has narrowed to one person and then
          screenshots this for them should not be sending a heading that
          claims to be the whole team. */}
      <PageHeader
        eyebrow="Calling"
        title={
          mine
            ? "Money raised"
            : chosen
              ? `Money raised by ${chosen.name}`
              : "Money raised"
        }
        subtitle={mine ? "Your total, payment by payment." : "By caller, payment by payment."}
        actions={
          <ExportButton
            path="/api/crm/reports/credits/export"
            params={filterParams()}
            filename="caller-credits"
            hint={t ? `${number(t.credits)} entries` : undefined}
          />
        }
      />

      <Toolbar
        activeCount={activeFilters}
        onClear={() =>
          refilter(() => {
            setKind("");
            setVerified("");
            setUserId("");
          })
        }
      >
        <Field label="Period">
          {/* Allowed to wrap: six periods on one line is wider than a phone,
              and a filter reachable only by scrolling sideways is a filter
              nobody uses. */}
          <SegmentedControl
            className="flex-wrap"
            options={PRESETS}
            value={preset}
            onChange={(v) => refilter(() => setPreset(v))}
          />
        </Field>
        <Field label="Type" className="w-48">
          <Select
            value={kind}
            onChange={(v) => refilter(() => setKind(v))}
            ariaLabel="Type"
            placeholder="Any"
            options={[
              { value: "", label: "Any" },
              ...KINDS.map((k) => ({ value: k.key, label: k.label, hint: k.hint })),
            ]}
          />
        </Field>
        <Field label="Checked" className="w-44">
          <Select
            value={verified}
            onChange={(v) => refilter(() => setVerified(v))}
            ariaLabel="Checked"
            placeholder="Any"
            options={[
              { value: "", label: "Any" },
              { value: "yes", label: "Checked" },
              { value: "no", label: "Not checked yet" },
            ]}
          />
        </Field>
        {canChooseCaller && (
          <Field label="Caller" className="w-52">
            <Select
              value={userId}
              onChange={(v) => refilter(() => setUserId(v))}
              ariaLabel="Caller"
              placeholder="Everyone"
              options={[
                { value: "", label: "Everyone" },
                ...callers.map((c) => ({ value: c.id, label: c.name, hint: c.role.replace(/_/g, " ") })),
              ]}
            />
          </Field>
        )}
      </Toolbar>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={mine ? "You raised" : "Raised"}
          value={currency(t?.raised ?? 0)}
          loading={loading}
          accent="brand"
          icon="rupee"
          sub={t ? `${number(t.credits)} entr${t.credits === 1 ? "y" : "ies"} · ${data?.range.label.toLowerCase()}` : undefined}
        />
        <StatTile
          label="Checked"
          value={currency(t?.verified ?? 0)}
          loading={loading}
          accent="good"
          icon="checkCircle"
        />
        {/* Its own figure, never folded into the total. Somebody reading one
            "raised" number cannot tell that part of it is a caller's own word
            and part of it is a Razorpay webhook, and the first time a figure
            is questioned that is exactly what they need to know. */}
        <StatTile
          label="Not checked yet"
          value={currency(t?.awaiting_verification ?? 0)}
          loading={loading}
          accent={t && t.awaiting_verification > 0 ? "warn" : "default"}
          icon="clock"
          sub="PhonePe or UPI"
        />
        <StatTile
          label="Collected by PhonePe"
          value={currency(t?.by_kind.offline ?? 0)}
          loading={loading}
          icon="rupee"
        />
      </div>

      {/* Said in plain words rather than left to a tile's caption. "Awaiting"
          looks like an accusation to the person whose money it is, and it is
          not one - it means nobody has opened the bank statement yet. */}
      {t && t.awaiting_verification > 0 && (
        <Alert tone="info">
          {currency(t.awaiting_verification)} paid by PhonePe or UPI is not checked yet.{" "}
          <Link href="/calling/collected" className="font-medium text-brand-700 hover:underline">
            Collected by PhonePe
          </Link>
        </Alert>
      )}

      {/* Full width rather than beside the table: the ledger is the screen,
          and a seven-column table squeezed into two thirds of it has to be
          scrolled sideways to read the receipt number - which is the column
          somebody opened this page to find. */}
      <Card className="mb-5">
        <CardHeader title="By type" icon="chart" subtitle={data?.range.label} />
        <ul className="grid gap-x-5 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
          {KINDS.map((k) => {
            const value = t?.by_kind[k.key] ?? 0;
            return (
              <li key={k.key}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="truncate text-ink-soft">{k.label}</span>
                  <span className="tabular-nums font-medium text-ink">{currency(value)}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-pill bg-sunken">
                  <div
                    className={`h-full rounded-pill ${k.key === "offline" ? "bg-warn" : "bg-brand-600"}`}
                    style={{ width: `${(value / maxKind) * 100}%` }}
                  />
                </div>
                <p className="mt-1 text-2xs leading-snug text-ink-faint">{k.hint}</p>
              </li>
            );
          })}
        </ul>

      </Card>

      <TableShell>
        <Thead>
          <Th>Date</Th>
          {canChooseCaller && <Th>Caller</Th>}
          <Th align="right">Amount</Th>
          <Th>Type</Th>
          <Th>Donor</Th>
          <Th>Receipt No.</Th>
          <Th>Checked</Th>
        </Thead>

        {loading ? (
          <SkeletonRows rows={8} cols={cols} />
        ) : (
          <Tbody>
            {!data?.credits.length ? (
              <tr>
                <td colSpan={cols}>
                  <EmptyState
                    icon="rupee"
                    title="Nothing in this period"
                    message={
                      activeFilters
                        ? "Clear filters or try a longer period."
                        : mine
                          ? "Money counted for you shows here."
                          : "Try a longer period."
                    }
                  />
                </td>
              </tr>
            ) : (
              data.credits.map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap text-xs text-ink-muted">
                    {shortDate(c.occurred_at)}
                    <div className="text-ink-faint">
                      {clockTime(c.occurred_at)} · {relativeDate(c.occurred_at)}
                    </div>
                  </Td>
                  {canChooseCaller && <Td className="text-sm">{c.caller_name}</Td>}
                  <Td align="right" className="whitespace-nowrap font-medium tabular-nums text-ink">
                    {currency(c.amount)}
                  </Td>
                  <Td>
                    <Badge tone={c.kind === "offline" ? "warn" : "neutral"}>{KIND_LABEL[c.kind]}</Badge>
                  </Td>
                  <Td>
                    <span className="block max-w-[18rem] truncate text-sm text-ink-soft">
                      {c.lead_name || c.link_label || c.note || <span className="text-ink-faint">—</span>}
                    </span>
                    {/* The Razorpay id or the UTR. Shown because it is what
                        a person quotes on the phone when a figure is
                        queried, and a credit nobody can trace back to a
                        payment is a credit nobody will believe. */}
                    {c.payment_reference && (
                      <span className="block truncate text-2xs text-ink-faint">{c.payment_reference}</span>
                    )}
                  </Td>
                  <Td className="text-xs tabular-nums text-ink-soft">
                    {c.receipt_number || <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td>{checkedCell(c)}</Td>
                </tr>
              ))
            )}
          </Tbody>
        )}

        {data && data.total > data.limit && (
          <tfoot>
            <tr>
              <td colSpan={cols} className="p-0">
                <Pagination
                  page={data.page}
                  limit={data.limit}
                  total={data.total}
                  totalPages={Math.max(1, Math.ceil(data.total / data.limit))}
                  onPage={setPage}
                  unit="entries"
                />
              </td>
            </tr>
          </tfoot>
        )}
      </TableShell>

      <p className="mt-3 text-xs text-ink-muted">
        <Link
          href="/calling/collected"
          className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
        >
          Collected by PhonePe
          <Icon name="arrowRight" size={12} />
        </Link>
      </p>
    </div>
  );
}

/**
 * Whether a human still has to look at this one.
 *
 * Three states rather than a tick and a cross, because `verified_at` means two
 * different things depending on the kind. On a QR, link or lead credit it was
 * set at insert, by the webhook or the sync that watched the money arrive -
 * there is nothing for a person to check. On an offline credit it is only ever
 * set by an admin reconciling the bank statement. Rendering both as "checked"
 * would make one word carry both meanings in a single column, which is exactly
 * the blur the ledger exists to remove.
 */
function checkedCell(c: Credit) {
  if (c.kind !== "offline") {
    return <span className="text-xs text-ink-muted">No check needed</span>;
  }
  if (c.verified) {
    return (
      <span>
        <Badge tone="good" dot>
          Checked
        </Badge>
        {c.verified_at && <div className="mt-0.5 text-2xs text-ink-muted">{dateTime(c.verified_at)}</div>}
      </span>
    );
  }
  return (
    <Badge tone="warn" dot>
      Not checked yet
    </Badge>
  );
}
