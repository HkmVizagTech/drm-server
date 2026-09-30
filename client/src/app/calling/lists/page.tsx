"use client";

// Calling lists — building them, and handing them to people.
//
// A list is a saved question, not a copy of the leads: "the March sheet",
// "everyone tagged janmashtami-2026", "JTMD's donors in Visakhapatnam". The
// queue answers it fresh every time, so a lead that converts or goes
// do-not-call leaves the list on its own and the counts here are never stale.
//
// WHY ASSIGNMENT IS HERE AND NOT ON THE CALLER'S SCREEN
// Handing a list to somebody is a decision about the campaign, made by whoever
// runs it. The caller's screen shows what they have been given and lets them
// choose something else; it is not where the giving happens.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  Modal,
  PageHeader,
  Select,
  TableShell,
  Td,
  Th,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/ui";

interface CallingList {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  origin: string;
  tag: string | null;
  city: string | null;
  status_slug: string | null;
  source: string | null;
  preacher_id: string | null;
  preacher_code: string | null;
  preacher_name: string | null;
  import_batch_id: string | null;
  batch_filename: string | null;
  batch_sheet: string | null;
  min_external_total: string | null;
  total: number;
  to_call: number;
  never_called: number;
  called: number;
  converted: number;
  created_by_name: string | null;
  created_at: string;
}

interface TeamMember {
  id: string;
  name: string;
  role: string;
}
interface Preacher {
  id: string;
  code: string;
  name: string | null;
}
interface Batch {
  id: string;
  filename: string;
  sheet_name: string | null;
  status: string;
}
interface Status {
  slug: string;
  label: string;
}

export default function CallingListsPage() {
  const [lists, setLists] = useState<CallingList[]>([]);
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [preachers, setPreachers] = useState<Preacher[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [assigning, setAssigning] = useState<CallingList | null>(null);
  const [showRetired, setShowRetired] = useState(false);

  const load = useCallback(async () => {
    try {
      const [l, cfg] = await Promise.all([
        apiClient.get<{ lists: CallingList[] }>(`/api/crm/lists${showRetired ? "?all=true" : ""}`),
        apiClient.get<{ users: TeamMember[]; statuses: Status[] }>("/api/crm/config"),
      ]);
      setLists(l.lists);
      setUsers(cfg.users);
      setStatuses(cfg.statuses);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the lists");
    } finally {
      setLoading(false);
    }
  }, [showRetired]);

  useEffect(() => {
    void load();
    // Only needed for the build-a-list form, so fetched once rather than on
    // every toggle of the retired filter.
    apiClient
      .get<{ preachers: Preacher[] }>("/api/crm/preachers?counts=false")
      .then((d) => setPreachers(d.preachers))
      .catch(() => undefined);
    apiClient
      .get<{ batches: Batch[] }>("/api/crm/import/batches")
      .then((d) => setBatches(d.batches.filter((b) => b.status === "applied")))
      .catch(() => undefined);
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Calling lists"
        subtitle="What a caller can pick up and work through. Every applied sheet becomes one automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/start" className={buttonSecondary}>
              Start calling
            </Link>
            <button onClick={() => setShowNew(true)} className={buttonPrimary}>
              Build a list
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <Card padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5">
          <CardHeader title={`${lists.length} list${lists.length === 1 ? "" : "s"}`} />
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(e) => setShowRetired(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show retired
          </label>
        </div>

        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>List</Th>
              <Th>Built from</Th>
              <Th align="right">To call</Th>
              <Th align="right">Reached</Th>
              <Th align="right">Donated</Th>
              <Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
            ) : !lists.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    title="No lists yet"
                    message="Apply an uploaded sheet and its list appears here, or build one from a tag, a preacher or a city."
                    action={<Link href="/calling/uploads" className={buttonPrimary}>Upload a sheet</Link>}
                  />
                </td>
              </tr>
            ) : (
              lists.map((l) => (
                <tr key={l.id} className={`hover:bg-slate-50/60 ${l.active ? "" : "opacity-60"}`}>
                  <Td>
                    <p className="font-medium text-slate-900">{l.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {l.origin === "import" ? "From a sheet" : "Built by hand"}
                      {l.created_by_name && ` · ${l.created_by_name}`}
                      {` · ${relativeDate(l.created_at)}`}
                    </p>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {l.batch_filename && (
                        <Badge tone="neutral">{l.batch_sheet || l.batch_filename}</Badge>
                      )}
                      {l.tag && <Badge tone="neutral">#{l.tag}</Badge>}
                      {l.preacher_code && <Badge tone="neutral">{l.preacher_name || l.preacher_code}</Badge>}
                      {l.city && <Badge tone="neutral">{l.city}</Badge>}
                      {l.min_external_total && (
                        <Badge tone="neutral">over {currency(Number(l.min_external_total))}</Badge>
                      )}
                      {!l.batch_filename && !l.tag && !l.preacher_code && !l.city && !l.min_external_total && (
                        <span className="text-xs text-slate-400">Everything</span>
                      )}
                    </div>
                  </Td>
                  <Td align="right" className="tabular-nums font-medium text-slate-900">{number(l.to_call)}</Td>
                  <Td align="right" className="tabular-nums text-slate-600">
                    {number(l.called)}<span className="text-slate-300"> / {number(l.total)}</span>
                  </Td>
                  <Td align="right" className="tabular-nums text-slate-600">
                    {l.converted ? number(l.converted) : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      <button
                        onClick={() => setAssigning(l)}
                        className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                      >
                        Give to…
                      </button>
                      <button
                        onClick={async () => {
                          await apiClient.put(`/api/crm/lists/${l.id}`, { active: !l.active });
                          await load();
                        }}
                        className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                      >
                        {l.active ? "Retire" : "Restore"}
                      </button>
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableShell>
      </Card>

      {showNew && (
        <NewListDialog
          preachers={preachers}
          batches={batches}
          statuses={statuses}
          onClose={() => setShowNew(false)}
          onDone={async () => {
            setShowNew(false);
            await load();
          }}
        />
      )}

      {assigning && (
        <AssignDialog
          list={assigning}
          users={users}
          onClose={() => setAssigning(null)}
          onDone={async () => {
            setAssigning(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Building a list.
 *
 * Every field is optional and they narrow together, so one form covers "the
 * March sheet" and "the March sheet, Vizag, over a lakh" without needing a
 * different kind of list for each. The live count underneath is what stops
 * somebody saving a list that turns out to select nobody.
 */
function NewListDialog({
  preachers,
  batches,
  statuses,
  onClose,
  onDone,
}: {
  preachers: Preacher[];
  batches: Batch[];
  statuses: Status[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [batch, setBatch] = useState("");
  const [tag, setTag] = useState("");
  const [preacher, setPreacher] = useState("");
  const [status, setStatus] = useState("");
  const [city, setCity] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const empty = !batch && !tag.trim() && !preacher && !status && !city.trim() && !minTotal;

  async function save() {
    if (!name.trim()) return setError("Give the list a name");
    setBusy(true);
    setError(null);
    try {
      await apiClient.post("/api/crm/lists", {
        name: name.trim(),
        import_batch_id: batch || undefined,
        tag: tag.trim() || undefined,
        preacher_id: preacher || undefined,
        status_slug: status || undefined,
        city: city.trim() || undefined,
        min_external_total: minTotal || undefined,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that list");
      setBusy(false);
    }
  }

  return (
    <Modal title="Build a calling list" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <label className="block text-xs text-slate-500">
        What to call it
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Janmashtami lapsed donors"
          className={`${inputClass} mt-1 w-full`}
        />
      </label>

      <p className="mt-4 mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
        Who is in it
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          From an uploaded sheet
          <Select
            value={batch}
            onChange={setBatch}
            className="mt-1 w-full"
            placeholder="Any sheet"
            options={[
              { value: "", label: "Any sheet" },
              ...batches.map((b) => ({
                value: b.id,
                label: b.sheet_name ? `${b.filename} — ${b.sheet_name}` : b.filename,
              })),
            ]}
          />
        </label>
        <label className="text-xs text-slate-500">
          With the tag
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Any tag"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Brought in by
          <Select
            value={preacher}
            onChange={setPreacher}
            className="mt-1 w-full"
            placeholder="Any preacher"
            options={[
              { value: "", label: "Any preacher" },
              ...preachers.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.code})` : p.code })),
            ]}
          />
        </label>
        <label className="text-xs text-slate-500">
          At stage
          <Select
            value={status}
            onChange={setStatus}
            className="mt-1 w-full"
            placeholder="Any stage"
            options={[{ value: "", label: "Any stage" }, ...statuses.map((s) => ({ value: s.slug, label: s.label }))]}
          />
        </label>
        <label className="text-xs text-slate-500">
          In or near
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Any city"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Has given at least
          <input
            value={minTotal}
            onChange={(e) => setMinTotal(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="Any amount"
            inputMode="numeric"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
      </div>

      {empty && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Nothing chosen, so this list will hold every lead — the same as &ldquo;Everything that is due&rdquo;.
          Narrow it unless that is what you want.
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button onClick={() => void save()} disabled={busy || !name.trim()} className={buttonPrimary}>
          {busy ? "Saving…" : "Create the list"}
        </button>
      </div>
    </Modal>
  );
}

/** Handing a list to callers. Checkboxes, saved as a set. */
function AssignDialog({
  list,
  users,
  onClose,
  onDone,
}: {
  list: CallingList;
  users: TeamMember[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiClient
      .get<{ assignees: { user_id: string; note: string | null }[] }>(`/api/crm/lists/${list.id}/assignees`)
      .then((d) => {
        setChosen(new Set(d.assignees.map((a) => a.user_id)));
        setNote(d.assignees[0]?.note ?? "");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load who has this"));
  }, [list.id]);

  return (
    <Modal title={`Who should call ${list.name}?`} onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <p className="mb-3 text-sm text-slate-600">
        It becomes their default when they press Start calling. They can still choose another list — a caller who
        finishes early should not be stuck.
      </p>

      <div className="max-h-64 space-y-1 overflow-y-auto scroll-slim">
        {users.map((u) => (
          <label
            key={u.id}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={chosen.has(u.id)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(u.id);
                else next.delete(u.id);
                setChosen(next);
              }}
              className="rounded border-slate-300"
            />
            <span className="text-sm text-slate-900">{u.name}</span>
            <span className="ml-auto text-[11px] capitalize text-slate-400">{u.role?.replace(/_/g, " ")}</span>
          </label>
        ))}
      </div>

      <label className="mt-4 block text-xs text-slate-500">
        A note for them (optional)
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Finish before Friday — the festival is on Saturday"
          className={`${inputClass} mt-1 w-full`}
        />
      </label>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await apiClient.put(`/api/crm/lists/${list.id}/assignees`, {
                user_ids: [...chosen],
                note: note.trim() || undefined,
              });
              onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save that");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
