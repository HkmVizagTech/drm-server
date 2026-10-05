"use client";

import { useCallback, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, number, relativeDate } from "@/lib/format";
import { ExportButton } from "@/components/export-button";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Icon,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
} from "@/components/ui";

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
  { value: "lifetime", label: "Highest total" },
  { value: "donations", label: "Most donations" },
  { value: "last_gift", label: "Most recent donation" },
  { value: "name", label: "Name (A–Z)" },
];

export default function PeoplePage() {
  const { user } = useAuth();
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
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

  /**
   * The filters, described once.
   *
   * Both the list request and the download read this. Building the query a
   * second time for the export is how a download ends up holding a different
   * set of people than the screen that was looked at before pressing it - and
   * the office acts on the file, not on the screen.
   */
  const filterParams = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: "25", sort });
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (roleFilter) params.set("role", roleFilter);
    if (siteFilter) params.set("site", siteFilter);
    if (groupFilter) params.set("group", groupFilter);
    return params;
  }, [page, sort, debouncedSearch, roleFilter, siteFilter, groupFilter]);

  const fetchPeople = useCallback(() => {
    setLoading(true);
    apiClient
      .get<PeopleResponse>(`/api/people?${filterParams()}`)
      .then((d) => {
        setData(d);
        setLoadError(null);
      })
      // An empty table is what a failed request used to look like. The screen
      // said "no records" when the truth was "the server refused", or "the
      // server broke" - indistinguishable to anybody without DevTools open,
      // and the reason a permissions bug can sit unnoticed for weeks.
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load. Try again."))
      .finally(() => setLoading(false));
  }, [filterParams]);

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
        `${label}: ${number(result.donorsProcessed)} donors. ` +
          `${number(result.peopleCreated)} new, ${number(result.donationsSynced)} donations, ` +
          `${number(result.subscriptionsSynced)} recurring, ${number(result.deliveriesSynced)} prasadam` +
          (result.failureCount ? `, ${number(result.failureCount)} skipped` : "") +
          (siteError ? `. Stopped early: ${siteError}` : "")
      );
      setPage(1);
      fetchPeople();
    } catch (err) {
      setImportMessage(`${label}: ${err instanceof Error ? err.message : "Import failed. Try again."}`);
    } finally {
      setImporting(null);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setRoleFilter("");
    setSiteFilter("");
    setGroupFilter("");
  };

  const people = data?.people ?? [];
  const activeFilters = [debouncedSearch, roleFilter, siteFilter, groupFilter].filter(Boolean).length;
  const hasFilters = activeFilters > 0;
  // The two roles the server lets through /api/people/export. A caller can read
  // this screen, so the button would be here for them - and it would answer 403
  // every time, which teaches people the download is broken rather than that it
  // is not theirs.
  const canExport = user?.role === "admin" || user?.role === "accountant";

  return (
    <div>
      <PageHeader
        eyebrow="Donors"
        title="People"
        subtitle={data ? `${number(data.total)} people${hasFilters ? " found" : ""}` : undefined}
        actions={
          <>
            {importSites.map((s) => (
              <Button
                key={s.key}
                variant="secondary"
                icon="refresh"
                onClick={() => runImport(s.key, s.label)}
                disabled={importing !== null}
                loading={importing === s.key}
                title={`Get donors from ${s.label}`}
              >
                {importing === s.key ? "Importing…" : `Import ${s.label}`}
              </Button>
            ))}
            {canExport && (
              <ExportButton
                path="/api/people/export"
                params={filterParams()}
                filename="people"
                hint={data ? `${number(data.total)} people` : undefined}
              />
            )}
            <Button icon="plus" onClick={() => setShowModal(true)}>
              Add person
            </Button>
          </>
        }
      />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      {importMessage && <Alert tone="warn">{importMessage}</Alert>}

      <Toolbar onClear={clearFilters} activeCount={activeFilters}>
        <Field label="Search" htmlFor="people-search" className="flex-1 min-w-[16rem]">
          <SearchInput
            id="people-search"
            value={search}
            onChange={setSearch}
            placeholder="Name, mobile or e-mail…"
          />
        </Field>
        <Field label="Role" className="flex-1 min-w-[9rem]">
          <Select value={roleFilter} onChange={(v) => setRoleFilter(v)} ariaLabel="Role">
            <option value="">All roles</option>
            {roleOptions.map((r) => (
              <option key={r} value={r}>
                {r[0].toUpperCase() + r.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Donation site" className="flex-1 min-w-[9rem]">
          <Select value={siteFilter} onChange={(v) => setSiteFilter(v)} ariaLabel="Donation site">
            <option value="">All sites</option>
            <option value="hkmv">HKMV site</option>
            <option value="annadan">Annadan site</option>
          </Select>
        </Field>
        <Field label="Donation page" className="flex-1 min-w-[9rem]">
          <Select value={groupFilter} onChange={(v) => setGroupFilter(v)} ariaLabel="Donation page">
            <option value="">Any page</option>
            <option value="donations">Donations pages</option>
            <option value="donate">Seva pages</option>
            <option value="other">Other pages</option>
          </Select>
        </Field>
        <Field label="Sort by" className="flex-1 min-w-[9rem]">
          <Select value={sort} onChange={(v) => setSort(v)} ariaLabel="Sort by">
            {sortOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      </Toolbar>

      <TableShell>
        <Thead>
          <Th>Person</Th>
          <Th>Roles</Th>
          <Th align="right">Donations</Th>
          <Th align="right">Total donated</Th>
          <Th align="right">Last donation</Th>
          <Th align="right"> </Th>
        </Thead>

        {loading && !data ? (
          <SkeletonRows rows={8} cols={6} />
        ) : (
          <Tbody>
            {people.map((p) => (
              <tr key={p.id}>
                <Td>
                  <Link href={`/people/${p.id}`} className="group flex items-center gap-3">
                    <Avatar name={p.name} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-ink group-hover:text-brand-700">
                        {p.name}
                      </span>
                      <span className="block text-xs tabular-nums text-ink-muted">
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
                      <span className="text-xs text-ink-faint">—</span>
                    )}
                    {p.active_subscriptions > 0 && (
                      <Badge tone="good">
                        {p.active_subscriptions} recurring
                      </Badge>
                    )}
                  </div>
                </Td>
                <Td align="right" className="tabular-nums">
                  {p.donation_count > 0 ? number(p.donation_count) : <span className="text-ink-faint">0</span>}
                </Td>
                <Td align="right">
                  {p.lifetime_total > 0 ? (
                    <span className="font-semibold tabular-nums text-ink">{currency(p.lifetime_total)}</span>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </Td>
                <Td align="right" className="whitespace-nowrap text-xs text-ink-muted">
                  {relativeDate(p.last_donation_at)}
                </Td>
                <Td align="right">
                  <Link
                    href={`/people/${p.id}`}
                    className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-brand-700 hover:underline"
                  >
                    View
                    <Icon name="arrowRight" size={13} />
                  </Link>
                </Td>
              </tr>
            ))}
          </Tbody>
        )}

        {!loading && people.length === 0 && (
          <tbody>
            <tr>
              <td colSpan={6}>
                <EmptyState
                  icon="users"
                  title={hasFilters ? "No matches" : "No people yet"}
                  message={
                    hasFilters
                      ? "Try another search or clear filters."
                      : "Import donors or add one."
                  }
                  action={
                    !hasFilters && importSites.length ? (
                      <div className="flex flex-wrap justify-center gap-2">
                        {importSites.map((s) => (
                          <Button
                            key={s.key}
                            icon="refresh"
                            onClick={() => runImport(s.key, s.label)}
                            disabled={importing !== null}
                            loading={importing === s.key}
                          >
                            {importing === s.key ? "Importing…" : `Import ${s.label}`}
                          </Button>
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
      setError(err instanceof Error ? err.message : "Could not save. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title="Add person"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* The dialog's footer sits outside the <form>, so the submit button
              is tied back to it by id. Without that it is a button in no form
              at all, and Add Person silently does nothing. */}
          <Button type="submit" form="add-person" loading={loading}>
            {loading ? "Saving…" : "Add"}
          </Button>
        </>
      }
    >
      <form id="add-person" onSubmit={handleSubmit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="person-name" required className="sm:col-span-2">
            <Input
              id="person-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </Field>
          <Field label="Mobile Number" htmlFor="person-phone" required>
            <Input
              id="person-phone"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              required
            />
          </Field>
          <Field label="E-mail ID (optional)" htmlFor="person-email">
            <Input
              id="person-email"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="PAN Number" hint="Needed for 80G" htmlFor="person-pan">
            <Input
              id="person-pan"
              value={form.pan}
              onChange={(e) => setForm({ ...form, pan: e.target.value })}
            />
          </Field>
          <Field label="Address" htmlFor="person-address">
            <Input
              id="person-address"
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </Field>
        </div>

        {/* Checkboxes rather than a segmented control or pill tabs: a person
            can hold several of these at once - a folk volunteer who also
            donates is the common case - and a control that only ever has one
            choice on would quietly drop the others. */}
        <div>
          <p className="mb-2 text-xs font-medium text-ink-soft">Roles</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {roleOptions.map((role) => (
              <Checkbox
                key={role}
                checked={roles.includes(role)}
                onChange={() => toggleRole(role)}
                label={role}
              />
            ))}
          </div>
        </div>
      </form>
    </Modal>
  );
}
