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
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toolbar,
  buttonPrimary,
  buttonSecondary,
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
        eyebrow="Calling"
        title="Calling lists"
        subtitle="What a caller can pick up and work through. Every applied sheet becomes one automatically."
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/start" className={buttonSecondary}>
              Start calling
            </Link>
            <Button icon="plus" onClick={() => setShowNew(true)}>
              Build a list
            </Button>
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Toolbar onClear={() => setShowRetired(false)} activeCount={showRetired ? 1 : 0}>
        <Field label="Retired lists">
          <Checkbox checked={showRetired} onChange={setShowRetired} label="Show them too" className="h-9.5" />
        </Field>
        <p className="ml-auto pb-2 text-xs text-ink-muted">
          {number(lists.length)} list{lists.length === 1 ? "" : "s"}
        </p>
      </Toolbar>

      {/* Deliberately not wrapped in a Card: TableShell already draws the
          bordered, shadowed surface, and nesting the two gives every table a
          double edge. */}
      <TableShell>
        <Thead>
          <Th>List</Th>
          <Th>Built from</Th>
          <Th align="right">To call</Th>
          <Th align="right">Reached</Th>
          <Th align="right">Donated</Th>
          <Th align="right">Actions</Th>
        </Thead>
        {loading ? (
          <SkeletonRows rows={6} cols={6} />
        ) : (
          <Tbody>
            {!lists.length ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon="list"
                    title="No lists yet"
                    message="Apply an uploaded sheet and its list appears here, or build one from a tag, a preacher or a city."
                    action={<Link href="/calling/uploads" className={buttonPrimary}>Upload a sheet</Link>}
                  />
                </td>
              </tr>
            ) : (
              lists.map((l) => (
                <tr key={l.id} className={l.active ? "" : "opacity-60"}>
                  <Td>
                    <p className="font-medium text-ink">{l.name}</p>
                    <p className="text-2xs text-ink-muted">
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
                        <span className="text-xs text-ink-faint">Everything</span>
                      )}
                    </div>
                  </Td>
                  <Td align="right" className="tabular-nums font-medium text-ink">{number(l.to_call)}</Td>
                  <Td align="right" className="tabular-nums text-ink-muted">
                    {number(l.called)}<span className="text-ink-faint"> / {number(l.total)}</span>
                  </Td>
                  <Td align="right" className="tabular-nums text-ink-muted">
                    {l.converted ? number(l.converted) : <span className="text-ink-faint">—</span>}
                  </Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="secondary" icon="userPlus" onClick={() => setAssigning(l)}>
                        Give to…
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          await apiClient.put(`/api/crm/lists/${l.id}`, { active: !l.active });
                          await load();
                        }}
                      >
                        {l.active ? "Retire" : "Restore"}
                      </Button>
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </Tbody>
        )}
      </TableShell>

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
    <Modal
      title="Build a calling list"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim()} loading={busy}>
            {busy ? "Saving…" : "Create the list"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="What to call it" htmlFor="list-name" required>
        <Input
          id="list-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Janmashtami lapsed donors"
        />
      </Field>

      <p className="mt-4 mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
        Who is in it
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From an uploaded sheet">
          <Select
            value={batch}
            onChange={setBatch}
            ariaLabel="From an uploaded sheet"
            placeholder="Any sheet"
            options={[
              { value: "", label: "Any sheet" },
              ...batches.map((b) => ({
                value: b.id,
                label: b.sheet_name ? `${b.filename} — ${b.sheet_name}` : b.filename,
              })),
            ]}
          />
        </Field>
        <Field label="With the tag" htmlFor="list-tag">
          <Input
            id="list-tag"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Any tag"
          />
        </Field>
        <Field label="Brought in by">
          <Select
            value={preacher}
            onChange={setPreacher}
            ariaLabel="Brought in by"
            placeholder="Any preacher"
            options={[
              { value: "", label: "Any preacher" },
              ...preachers.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.code})` : p.code })),
            ]}
          />
        </Field>
        <Field label="At stage">
          <Select
            value={status}
            onChange={setStatus}
            ariaLabel="At stage"
            placeholder="Any stage"
            options={[{ value: "", label: "Any stage" }, ...statuses.map((s) => ({ value: s.slug, label: s.label }))]}
          />
        </Field>
        <Field label="In or near" htmlFor="list-city">
          <Input
            id="list-city"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="Any city"
          />
        </Field>
        <Field label="Has given at least" htmlFor="list-min">
          <Input
            id="list-min"
            value={minTotal}
            onChange={(e) => setMinTotal(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="Any amount"
            inputMode="numeric"
            className="tabular-nums"
          />
        </Field>
      </div>

      {empty && (
        <Alert tone="warn" className="mt-3 mb-0">
          Nothing chosen, so this list will hold every lead — the same as &ldquo;Everything that is due&rdquo;.
          Narrow it unless that is what you want.
        </Alert>
      )}
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
    <Modal
      title={`Who should call ${list.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            disabled={busy}
            loading={busy}
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
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <p className="mb-3 text-sm text-ink-muted">
        It becomes their default when they press Start calling. They can still choose another list — a caller who
        finishes early should not be stuck.
      </p>

      <div className="max-h-64 space-y-1 overflow-y-auto scroll-slim">
        {users.map((u) => (
          <div
            key={u.id}
            className="flex items-center gap-3 rounded-control px-3 py-2 transition-colors hover:bg-brand-50/60"
          >
            <Checkbox
              checked={chosen.has(u.id)}
              onChange={(on) => {
                const next = new Set(chosen);
                if (on) next.add(u.id);
                else next.delete(u.id);
                setChosen(next);
              }}
              label={u.name}
            />
            <span className="ml-auto text-2xs capitalize text-ink-faint">{u.role?.replace(/_/g, " ")}</span>
          </div>
        ))}
      </div>

      <Field label="A note for them (optional)" htmlFor="assign-note" className="mt-4">
        <Input
          id="assign-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Finish before Friday — the festival is on Saturday"
        />
      </Field>
    </Modal>
  );
}
