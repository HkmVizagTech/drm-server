"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate } from "@/lib/format";
import { Avatar, Badge, buttonPrimary, buttonSecondary, Card, EmptyState, inputClass, PageHeader, Pagination, Select, SkeletonRows, TableShell, Td, Th } from "@/components/ui";

interface Person {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  pan?: string;
  roles: string[];
  // Donation rollup for this person. One person = one phone number, so every
  // donation that donor has ever made - website, recurring charge or manual entry -
  // aggregates into these three fields.
  donation_count: number;
  lifetime_total: number;
  last_donation_at?: string | null;
  active_subscriptions: number;
}

interface PeopleResponse {
  people: Person[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

const roleOptions = ["donor", "volunteer", "folk", "congregation"];

const sortOptions = [
  { value: "recent", label: "Recently added" },
  { value: "lifetime", label: "Highest total donated" },
  { value: "donations", label: "Most donations" },
  { value: "last_gift", label: "Most recent donation" },
  { value: "name", label: "Name (A–Z)" },
];

export default function PeoplePage() {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  // Which donation site the person has given through, and which family of
  // pages. Both are server-side filters so the counts and paging stay right.
  const [siteFilter, setSiteFilter] = useState("");
  const [groupFilter, setGroupFilter] = useState("");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [showModal, setShowModal] = useState(false);
  // One button per configured donation site, rather than a single "import
  // everything" - the sites are separate systems and staff usually want to
  // refresh one of them, not re-pull both.
  const [importSites, setImportSites] = useState<{ key: string; label: string }[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const [importMessage, setImportMessage] = useState("");

  // Debounced so typing a name doesn't fire a query per keystroke against a
  // table with thousands of rows.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Any filter change invalidates the current page number - staying on page 12
  // of a result set that now has 2 pages shows an empty table.
  useEffect(() => setPage(1), [debouncedSearch, roleFilter, sort, siteFilter, groupFilter]);

  const fetchPeople = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), limit: "25", sort });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (roleFilter) params.set("role", roleFilter);
    if (siteFilter) params.set("site", siteFilter);
    if (groupFilter) params.set("group", groupFilter);
    apiClient
      .get<PeopleResponse>(`/api/people?${params}`)
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [page, sort, debouncedSearch, roleFilter, siteFilter, groupFilter]);

  useEffect(fetchPeople, [fetchPeople]);

  useEffect(() => {
    apiClient
      .get<{ sites: { key: string; label: string }[] }>("/api/people/import-sites")
      .then((r) => setImportSites(r.sites))
      .catch(() => setImportSites([]));
  }, []);

  const runImport = async (siteKey: string, label: string) => {
    setImporting(siteKey);
    setImportMessage("");
    try {
      const result = await apiClient.post<{
        donorsProcessed: number;
        peopleCreated: number;
        donationsSynced: number;
        subscriptionsSynced: number;
        deliveriesSynced: number;
        failureCount: number;
        sites?: Record<string, { error?: string }>;
      }>("/api/people/import-hkmv", { site: siteKey, pageSize: 100 });

      const siteError = result.sites?.[siteKey]?.error;
      setImportMessage(
        `${label}: ${number(result.donorsProcessed)} donors — ` +
          `${number(result.peopleCreated)} new, ${number(result.donationsSynced)} donations, ` +
          `${number(result.subscriptionsSynced)} subscriptions, ${number(result.deliveriesSynced)} prasadam` +
          (result.failureCount ? `, ${number(result.failureCount)} skipped` : "") +
          (siteError ? ` — stopped early: ${siteError}` : "")
      );
      setPage(1);
      fetchPeople();
    } catch (err) {
      setImportMessage(`${label}: ${err instanceof Error ? err.message : "import failed"}`);
    } finally {
      setImporting(null);
    }
  };

  const people = data?.people ?? [];
  const hasFilters = Boolean(debouncedSearch || roleFilter || siteFilter || groupFilter);

  return (
    <div>
      <PageHeader
        title="People"
        subtitle={data ? `${number(data.total)} records${hasFilters ? " matching your filters" : ""}` : undefined}
        actions={
          <>
            {importSites.map((s) => (
              <button
                key={s.key}
                onClick={() => runImport(s.key, s.label)}
                disabled={importing !== null}
                className={buttonSecondary}
                title={`Pull donors and donations from ${s.label}. Safe to re-run - it updates rather than duplicates.`}
              >
                {importing === s.key ? "Importing…" : `Import ${s.label}`}
              </button>
            ))}
            <button onClick={() => setShowModal(true)} className={buttonPrimary}>
              + Add Person
            </button>
          </>
        }
      />

      {importMessage && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
          {importMessage}
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, phone or email…"
          className={`${inputClass} flex-1 min-w-[16rem]`}
        />
        <Select value={roleFilter} onChange={(v) => setRoleFilter(v)} className="flex-1 min-w-[9rem]">
          <option value="">All roles</option>
          {roleOptions.map((r) => (
            <option key={r} value={r}>
              {r[0].toUpperCase() + r.slice(1)}
            </option>
          ))}
        </Select>
        <Select
          value={siteFilter}
          onChange={(v) => setSiteFilter(v)}
          className="flex-1 min-w-[9rem]"
          aria-label="Filter by donation site"
        >
          <option value="">All sites</option>
          <option value="hkmv">HKMV site</option>
          <option value="annadan">Annadan site</option>
        </Select>
        <Select
          value={groupFilter}
          onChange={(v) => setGroupFilter(v)}
          className="flex-1 min-w-[9rem]"
          aria-label="Filter by donation page"
        >
          <option value="">Any page</option>
          <option value="donations">Donations page (incl. nested)</option>
          <option value="donate">Donate — seva campaigns</option>
          <option value="other">Other pages</option>
        </Select>
        <Select value={sort} onChange={(v) => setSort(v)} className="flex-1 min-w-[9rem]">
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>

      <TableShell>
        <thead className="bg-slate-50/80">
          <tr>
            <Th>Person</Th>
            <Th>Roles</Th>
            <Th align="right">Donations</Th>
            <Th align="right">Total donated</Th>
            <Th align="right">Last donation</Th>
            <Th align="right"> </Th>
          </tr>
        </thead>

        {loading && !data ? (
          <SkeletonRows rows={8} cols={6} />
        ) : (
          <tbody className="divide-y divide-slate-100">
            {people.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50 transition-colors">
                <Td>
                  <Link href={`/people/${p.id}`} className="flex items-center gap-3 group">
                    <Avatar name={p.name} />
                    <span className="min-w-0">
                      <span className="block font-medium text-slate-900 group-hover:text-[var(--accent)] truncate">
                        {p.name}
                      </span>
                      <span className="block text-xs text-slate-500 tabular-nums">
                        {p.phone}
                        {p.email ? ` · ${p.email}` : ""}
                      </span>
                    </span>
                  </Link>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {p.roles.length ? (
                      p.roles.map((r) => (
                        <Badge key={r} tone={r === "donor" ? "brand" : "neutral"}>
                          {r}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-slate-400 text-xs">—</span>
                    )}
                    {p.active_subscriptions > 0 && (
                      <Badge tone="good">
                        {p.active_subscriptions} recurring
                      </Badge>
                    )}
                  </div>
                </Td>
                <Td align="right" className="tabular-nums text-slate-700">
                  {p.donation_count > 0 ? number(p.donation_count) : <span className="text-slate-300">0</span>}
                </Td>
                <Td align="right">
                  {p.lifetime_total > 0 ? (
                    <span className="font-semibold tabular-nums text-slate-900">{currency(p.lifetime_total)}</span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </Td>
                <Td align="right" className="text-xs text-slate-500 whitespace-nowrap">
                  {relativeDate(p.last_donation_at)}
                </Td>
                <Td align="right">
                  <Link
                    href={`/people/${p.id}`}
                    className="text-xs font-medium text-[var(--accent)] hover:underline whitespace-nowrap"
                  >
                    View →
                  </Link>
                </Td>
              </tr>
            ))}
          </tbody>
        )}

        {!loading && people.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={6}>
                <EmptyState
                  title={hasFilters ? "No matches" : "No people yet"}
                  message={
                    hasFilters
                      ? "Try a different search term or clear the filters."
                      : "Import your donors from the HKMV site, or add someone manually."
                  }
                  action={
                    !hasFilters && importSites.length ? (
                      <div className="flex flex-wrap gap-2 justify-center">
                        {importSites.map((s) => (
                          <button
                            key={s.key}
                            onClick={() => runImport(s.key, s.label)}
                            disabled={importing !== null}
                            className={buttonPrimary}
                          >
                            {importing === s.key ? "Importing…" : `Import ${s.label}`}
                          </button>
                        ))}
                      </div>
                    ) : undefined
                  }
                />
              </td>
            </tr>
          </tbody>
        )}

        {data && (
          <tfoot>
            <tr>
              <td colSpan={6} className="p-0">
                <Pagination
                  page={data.page}
                  limit={data.limit}
                  total={data.total}
                  totalPages={data.totalPages}
                  onPage={setPage}
                  unit="people"
                />
              </td>
            </tr>
          </tfoot>
        )}
      </TableShell>

      {showModal && <AddPersonModal onClose={() => setShowModal(false)} onAdded={fetchPeople} />}
    </div>
  );
}

function AddPersonModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", pan: "" });
  const [roles, setRoles] = useState<string[]>(["donor"]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const toggleRole = (role: string) =>
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await apiClient.post("/api/people", { ...form, roles });
      onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add person");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <form onSubmit={handleSubmit} className="bg-white rounded-2xl p-6 w-full max-w-lg space-y-4 shadow-xl">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Add Person</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Phone number is the unique key — an existing donor with this number will not be duplicated.
          </p>
        </div>

        {error && <div className="bg-red-50 text-red-700 text-sm p-3 rounded-lg border border-red-200">{error}</div>}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Full name *"
            required
            className={`${inputClass} w-full sm:col-span-2`}
          />
          <input
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="Phone number *"
            required
            className={`${inputClass} w-full`}
          />
          <input
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Email"
            type="email"
            className={`${inputClass} w-full`}
          />
          <input
            value={form.pan}
            onChange={(e) => setForm({ ...form, pan: e.target.value })}
            placeholder="PAN (for 80G receipts)"
            className={`${inputClass} w-full`}
          />
          <input
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            placeholder="Address"
            className={`${inputClass} w-full`}
          />
        </div>

        <div>
          <p className="text-sm font-medium text-slate-700 mb-2">Roles</p>
          <div className="flex gap-2 flex-wrap">
            {roleOptions.map((role) => (
              <button
                key={role}
                type="button"
                onClick={() => toggleRole(role)}
                className={`px-3 py-1.5 rounded-full text-sm transition-colors ${
                  roles.includes(role)
                    ? "bg-[var(--accent)] text-white"
                    : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                }`}
              >
                {role}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={onClose} className={`${buttonSecondary} flex-1 justify-center`}>
            Cancel
          </button>
          <button type="submit" disabled={loading} className={`${buttonPrimary} flex-1 justify-center`}>
            {loading ? "Saving…" : "Add Person"}
          </button>
        </div>
      </form>
    </div>
  );
}
