"use client";

// The receipts a devotee raised, and the seva list they raise them against.
//
// My receipts: every receipt this devotee raised on the HKM Vizag site (HKMI or TSC), newest
// first - a table on a wide screen, cards on a phone - each with WhatsApp (the donor's chat, with
// the receipt link), Download and, where the phone can, Share PDF. Only they see this list.
// Seva list: the temple's sevas with their codes - the HKMI categories and their sevas, and the
// TSC sevas - for reference while talking to a donor.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, shortDate } from "@/lib/format";
import { LEADS_CHANGED, leadsChanged, tileMoney } from "@/lib/devotee";
import { toast } from "@/components/toast";
import { Alert, Badge, Button, Card, EmptyState, SearchInput, SegmentedControl, Skeleton, StatTile, TableShell, Tbody, Td, Th, Thead } from "@/components/ui";
import { ReceiptActions } from "@/components/devotee/receipt-share";
import { useSevaCatalog, type CatalogSeva } from "@/components/receipts/seva-picker";
import { DevoteeReceiptDialog } from "@/components/devotee/receipt-dialog";

interface Receipt {
  id: string;
  lead_id: string | null;
  account: "HKMI" | "TSC";
  seva_name: string | null;
  donor_name: string;
  donor_mobile: string;
  on_name_of: string | null;
  amount: number;
  payment_mode: string;
  reference: string | null;
  paid_on: string | null;
  receipt_number: string | null;
  share_token: string | null;
  /** issued: DCC numbered it. failed / pending: not yet - retry it. */
  status: "issued" | "failed" | "pending";
  dcc_error: string | null;
  created_at: string;
}

interface ReceiptList {
  rows: Receipt[];
  count: number;
  amount: number;
  this_month: number;
  not_issued: number;
}

/** A receipt DCC has not numbered yet: why, and one tap to send it again. */
function RetryReceipt({ r, compact = false }: { r: Receipt; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      const out = await apiClient.post<{ receiptNumber: string }>(`/api/devotee/receipts/${r.id}/retry`, {});
      toast.success("Receipt issued", `No. ${out.receiptNumber}`);
      leadsChanged();
    } catch (e) {
      toast.error("Still not issued", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size={compact ? "xs" : "sm"} icon="refresh" loading={busy} onClick={() => void retry()}>
        Retry
      </Button>
      {!compact && r.dcc_error && <span className="text-xs text-danger">{r.dcc_error}</span>}
    </div>
  );
}

/** Send / download for an issued receipt; Retry for one DCC has not issued. */
const Actions = ({ r, compact = false }: { r: Receipt; compact?: boolean }) =>
  r.status === "issued" ? <ReceiptActions r={r} compact={compact} /> : <RetryReceipt r={r} compact={compact} />;

const MODE: Record<string, string> = { cash: "Cash", upi: "UPI", cheque: "Cheque", bank: "Bank" };

/** One receipt as a card, for a phone. */
function ReceiptCard({ r }: { r: Receipt }) {
  return (
    <li className="rounded-card border border-line-soft bg-surface p-3.5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <DonorName r={r} />
            <Badge tone={r.account === "TSC" ? "warn" : "brand"}>{r.account}</Badge>
            {r.status !== "issued" && <Badge tone="danger">Not issued</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">{r.seva_name ?? "Seva"}</p>
          <p className="mt-0.5 text-xs tabular-nums text-ink-faint">
            {shortDate(r.paid_on ?? r.created_at)} · {MODE[r.payment_mode] ?? r.payment_mode} · {r.donor_mobile}
          </p>
        </div>
        <div className="text-right">
          <p className="text-base font-semibold tabular-nums text-ink">{currency(r.amount)}</p>
          {r.receipt_number && <p className="font-mono text-xs text-brand-700">{r.receipt_number}</p>}
        </div>
      </div>
      <div className="mt-3 border-t border-line-soft pt-3">
        <Actions r={r} />
      </div>
    </li>
  );
}

function DonorName({ r }: { r: Receipt }) {
  return r.lead_id ? (
    <Link href={`/devotee/leads/${r.lead_id}`} className="font-semibold text-ink hover:underline">
      {r.donor_name}
    </Link>
  ) : (
    <span className="font-semibold text-ink">{r.donor_name}</span>
  );
}

/** Every receipt as a row, for a wider screen. */
function ReceiptTable({ rows }: { rows: Receipt[] }) {
  return (
    <TableShell>
      <Thead>
        <Th>Date</Th>
        <Th>Donor</Th>
        <Th>Seva</Th>
        <Th align="right">Amount</Th>
        <Th>Paid by</Th>
        <Th>Receipt No.</Th>
        <Th>Send / download</Th>
      </Thead>
      <Tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td className="whitespace-nowrap">{shortDate(r.paid_on ?? r.created_at)}</Td>
            <Td>
              <DonorName r={r} />
              <p className="text-xs tabular-nums text-ink-muted">{r.donor_mobile}</p>
            </Td>
            <Td>
              <span className="flex items-center gap-1.5">
                <Badge tone={r.account === "TSC" ? "warn" : "brand"}>{r.account}</Badge>
                <span className="text-sm text-ink-soft">{r.seva_name ?? "-"}</span>
              </span>
            </Td>
            <Td align="right" className="font-semibold tabular-nums">{currency(r.amount)}</Td>
            <Td>{MODE[r.payment_mode] ?? r.payment_mode}</Td>
            <Td className="font-mono text-xs text-brand-700">
              {r.receipt_number ?? <Badge tone="danger">Not issued</Badge>}
            </Td>
            <Td>
              <Actions r={r} compact />
            </Td>
          </tr>
        ))}
      </Tbody>
    </TableShell>
  );
}

function MyReceipts({ onRaise }: { onRaise: () => void }) {
  const [q, setQ] = useState("");
  const [data, setData] = useState<ReceiptList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const again = () => setTick((t) => t + 1);
    window.addEventListener(LEADS_CHANGED, again);
    return () => window.removeEventListener(LEADS_CHANGED, again);
  }, []);

  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      apiClient
        .get<ReceiptList>(`/api/devotee/receipts${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`)
        .then((r) => {
          if (!live) return;
          setData(r);
          setError(null);
        })
        .catch((e: Error) => live && setError(e.message));
    }, q ? 250 : 0);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, tick]);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Raised this month" value={tileMoney(data?.this_month ?? 0)} sub={data ? currency(data.this_month) : undefined} accent="good" icon="rupee" loading={!data} />
        <StatTile label="Receipts" value={data?.count ?? 0} sub={data ? `${currency(data.amount)} in all` : undefined} icon="receipt" loading={!data} />
      </div>
      {data && data.not_issued > 0 && (
        <Alert tone="warn">
          {data.not_issued} receipt{data.not_issued === 1 ? " was" : "s were"} not issued by DCC. Tap Retry on {data.not_issued === 1 ? "it" : "each"} - it is never issued twice.
        </Alert>
      )}
      <SearchInput value={q} onChange={setQ} placeholder="Search donor, number, receipt no. or seva" aria-label="Search receipts" />
      {error && <Alert tone="danger">{error}</Alert>}
      {!data ? (
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-28 w-full" rounded="rounded-card" />
          ))}
        </div>
      ) : data.rows.length === 0 ? (
        <Card>
          <EmptyState
            icon="receipt"
            title={q ? "No receipts match" : "No receipts yet"}
            message={q ? "Try another name or number." : "When a donor gives you cash, UPI, a cheque or a bank transfer, raise the receipt here, then send it to them from your WhatsApp."}
            action={q ? undefined : <Button icon="plus" onClick={onRaise}>Raise receipt</Button>}
          />
        </Card>
      ) : (
        <>
          <ul className="space-y-2 md:hidden">
            {data.rows.map((r) => (
              <ReceiptCard key={r.id} r={r} />
            ))}
          </ul>
          <div className="hidden md:block">
            <ReceiptTable rows={data.rows} />
          </div>
        </>
      )}
    </div>
  );
}

/** The seva list: HKMI by category, then TSC. Read-only. */
function SevaList() {
  const { sevas, ready } = useSevaCatalog();
  const [account, setAccount] = useState<"HKMI" | "TSC">("HKMI");
  const [q, setQ] = useState("");

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const rows = sevas.filter(
      (s) =>
        (s.accountType ?? "HKMI") === account &&
        (!term || [s.category, s.subCategory, s.subCode ?? "", s.code].some((x) => x.toLowerCase().includes(term)))
    );
    const byCategory = new Map<string, Map<number, CatalogSeva[]>>();
    for (const s of rows) {
      const cat = byCategory.get(s.category) ?? new Map<number, CatalogSeva[]>();
      cat.set(s.subCategoryId, [...(cat.get(s.subCategoryId) ?? []), s]);
      byCategory.set(s.category, cat);
    }
    return [...byCategory].map(([category, subs]) => ({ category, subs: [...subs.values()] }));
  }, [sevas, account, q]);

  if (!ready) return <Skeleton className="h-60 w-full" rounded="rounded-card" />;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SegmentedControl
          solid
          options={[
            { value: "HKMI", label: "HKMI" },
            { value: "TSC", label: "TSC" },
          ]}
          value={account}
          onChange={(v) => setAccount(v as "HKMI" | "TSC")}
        />
        <SearchInput value={q} onChange={setQ} placeholder="Search seva or code" className="sm:flex-1" aria-label="Search sevas" />
      </div>
      {groups.length === 0 ? (
        <Card>
          <EmptyState icon="list" title="No sevas match" message="Try another word or code." />
        </Card>
      ) : (
        groups.map((g) => (
          <Card key={g.category} padded={false}>
            <h3 className="border-b border-line-soft px-4 py-2.5 text-sm font-semibold text-ink">{g.category}</h3>
            <ul className="divide-y divide-line-soft">
              {g.subs.map((rows) => {
                const head = rows[0];
                const subs = rows.filter((r) => r.subCode);
                return (
                  <li key={head.subCategoryId} className="px-4 py-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm text-ink">{head.subCategory}</span>
                      <span className="font-mono text-xs text-ink-muted">{head.code}</span>
                    </div>
                    {subs.length > 0 && (
                      <p className="mt-1 text-xs text-ink-muted">{subs.map((s) => s.subCode).join(" · ")}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ))
      )}
    </div>
  );
}

export default function DevoteeReceiptsPage() {
  const [tab, setTab] = useState<"mine" | "sevas">("mine");
  const [raising, setRaising] = useState(false);
  const raise = useCallback(() => setRaising(true), []);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Receipts</h1>
          <p className="text-sm text-ink-muted">Raise HKMI or TSC receipts for donations you collect, and send them to the donor from your WhatsApp.</p>
        </div>
        <Button icon="receipt" onClick={raise}>
          Raise receipt
        </Button>
      </div>
      <SegmentedControl
        options={[
          { value: "mine", label: "My receipts", icon: "receipt" },
          { value: "sevas", label: "Seva list", icon: "list" },
        ]}
        value={tab}
        onChange={(v) => setTab(v as "mine" | "sevas")}
      />
      {tab === "mine" ? <MyReceipts onRaise={raise} /> : <SevaList />}
      {raising && <DevoteeReceiptDialog onClose={() => setRaising(false)} />}
    </div>
  );
}
