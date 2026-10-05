"use client";

// Calling lists — building them, and handing them to people.
//
// A list is a saved question, not a copy of the leads: "the March sheet",
// "everyone tagged janmashtami-2026", "JTMD's donors in Visakhapatnam". The
// queue answers it fresh every time, so a lead that converts or goes
// do-not-call leaves the list on its own and the counts here are never stale.
// A list can also hold people added by hand (or leave some out), for the
// lists that are not a filter at all - "these twelve, from Sunday's stall".
//
// WHY ASSIGNMENT IS HERE AND NOT ON THE CALLER'S SCREEN
// Handing a list to somebody is a decision about the campaign, made by whoever
// runs it. The caller's screen shows what they have been given and lets them
// choose something else; it is not where the giving happens. So callers see
// the lists and can start one, and every control that changes a list is drawn
// only for admins and accountants - the server refuses everyone else.
//
// WHY CARDS AND NOT A TABLE
// Callers open this on a phone to pick what to ring next. A six-column table
// at 390px is a sideways scroll to find the one button that matters; a card
// puts "12 to call" and Start calling together where a thumb can reach them.

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { runHref, startRun } from "@/lib/calling";
import { currency, number, relativeDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  DropdownMenu,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Skeleton,
  Textarea,
  Toggle,
  Toolbar,
  buttonClass,
  buttonPrimary,
  buttonSecondary,
} from "@/components/ui";
import { toast } from "@/components/toast";

interface CallingList {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  origin: string;
  members_only: boolean;
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
  /** What a run started now would hand THIS person: theirs or nobody's. */
  to_call: number;
  /** The same for the whole team. */
  to_call_all: number;
  never_called: number;
  called: number;
  converted: number;
  added_by_hand: number;
  left_out: number;
  assigned_to_me: boolean;
  assignment_note: string | null;
  /** An open run on this list, for this person. */
  session_id: string | null;
  session_calls: number | null;
  session_last_active: string | null;
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

const SOURCES = [
  { key: "donor", label: "Existing donors" },
  { key: "csv", label: "Uploaded list" },
  { key: "website", label: "Website enquiry" },
  { key: "walk_in", label: "Walk-in" },
  { key: "referral", label: "Referral" },
  { key: "event", label: "Event" },
  { key: "manual", label: "Added by hand" },
];

/** What a list selects by, as the form edits it. "" means "any". */
interface ListFilters {
  import_batch_id: string;
  tag: string;
  preacher_id: string;
  status_slug: string;
  source: string;
  city: string;
  min_external_total: string;
}

const NO_FILTERS: ListFilters = {
  import_batch_id: "",
  tag: "",
  preacher_id: "",
  status_slug: "",
  source: "",
  city: "",
  min_external_total: "",
};

const plural = (n: number, one: string, many: string) => `${number(n)} ${n === 1 ? one : many}`;

export default function CallingListsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const elevated = user?.role === "admin" || user?.role === "accountant";

  const [lists, setLists] = useState<CallingList[]>([]);
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [preachers, setPreachers] = useState<Preacher[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [assigning, setAssigning] = useState<CallingList | null>(null);
  const [editing, setEditing] = useState<CallingList | null>(null);
  const [sharing, setSharing] = useState<CallingList | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  const load = useCallback(
    () =>
      Promise.all([
        apiClient.get<{ lists: CallingList[] }>(`/api/crm/lists${showRetired ? "?all=true" : ""}`),
        apiClient.get<{ users: TeamMember[]; statuses: Status[] }>("/api/crm/config"),
      ]).then(
        ([l, cfg]) => {
          setLists(l.lists);
          setUsers(cfg.users);
          setStatuses(cfg.statuses);
          setError(null);
          setLoading(false);
        },
        (e) => {
          setError(e instanceof Error ? e.message : "Could not load lists. Try again.");
          setLoading(false);
        }
      ),
    [showRetired]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Only needed for the list editor, so fetched once rather than on every
  // toggle of the retired filter - and not at all for a caller, who cannot
  // open the editor.
  useEffect(() => {
    if (!elevated) return;
    apiClient
      .get<{ preachers: Preacher[] }>("/api/crm/preachers?counts=false")
      .then((d) => setPreachers(d.preachers))
      .catch(() => undefined);
    apiClient
      .get<{ batches: Batch[] }>("/api/crm/import/batches")
      .then((d) => setBatches(d.batches.filter((b) => b.status === "applied")))
      .catch(() => undefined);
  }, [elevated]);

  /**
   * Start, or carry on with, a run on this list. The server resumes an open
   * run rather than starting a second one, so "Carry on" and "Start" are the
   * same request - only the label differs.
   */
  async function start(l: CallingList) {
    setStarting(l.id);
    try {
      const run = await startRun({ kind: "list", list_id: l.id });
      if (run.empty || !run.session) {
        toast.info(`No one to call on “${l.name}” right now`);
        void load();
        return;
      }
      router.push(runHref(run.session.id));
    } catch (e) {
      toast.error("Could not start calling. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setStarting(null);
    }
  }

  async function setActive(l: CallingList, active: boolean) {
    try {
      await apiClient.put(`/api/crm/lists/${l.id}`, { active });
      toast(active ? `Brought “${l.name}” back` : `Retired “${l.name}”`, {
        action: { label: "Undo", onClick: () => void setActive(l, !active) },
      });
      await load();
    } catch (e) {
      toast.error("Could not save. Try again.", e instanceof Error ? e.message : undefined);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Calling"
        title="Lists"
        subtitle="Groups of people to call."
        actions={
          <>
            <Link href="/calling/start" className={buttonSecondary}>
              Start calling
            </Link>
            {elevated && (
              <Button icon="plus" onClick={() => setShowNew(true)}>
                New list
              </Button>
            )}
          </>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {elevated && (
        <Toolbar onClear={() => setShowRetired(false)} activeCount={showRetired ? 1 : 0}>
          <Field label="Retired lists">
            <Checkbox checked={showRetired} onChange={setShowRetired} label="Show" className="h-9.5" />
          </Field>
          <p className="ml-auto pb-2 text-xs text-ink-muted">{plural(lists.length, "list", "lists")}</p>
        </Toolbar>
      )}

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/3" />
              <Skeleton className="mt-5 h-8 w-20" />
              <Skeleton className="mt-5 h-9.5 w-full" />
            </Card>
          ))}
        </div>
      ) : !lists.length ? (
        <Card padded={false}>
          <EmptyState
            icon="list"
            title="No lists yet"
            message={
              elevated
                ? "Upload a sheet or make a new list."
                : "Ask your admin for a list."
            }
            action={
              elevated ? (
                <Link href="/calling/uploads" className={buttonPrimary}>
                  Upload a sheet
                </Link>
              ) : (
                <Link href="/calling/start" className={buttonPrimary}>
                  Start calling
                </Link>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {lists.map((l) => (
            <ListCard
              key={l.id}
              list={l}
              elevated={elevated}
              starting={starting === l.id}
              onStart={() => void start(l)}
              onEdit={() => setEditing(l)}
              onShare={() => setSharing(l)}
              onAssign={() => setAssigning(l)}
              onRetire={() => void setActive(l, !l.active)}
            />
          ))}
        </div>
      )}

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

      {editing && (
        <EditListDialog
          list={editing}
          preachers={preachers}
          batches={batches}
          statuses={statuses}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {sharing && (
        <SplitDialog
          list={sharing}
          users={users}
          onClose={() => setSharing(null)}
          onDone={async () => {
            setSharing(null);
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

/* ------------------------------------------------------------- the card */

function ListCard({
  list: l,
  elevated,
  starting,
  onStart,
  onEdit,
  onShare,
  onAssign,
  onRetire,
}: {
  list: CallingList;
  elevated: boolean;
  starting: boolean;
  onStart: () => void;
  onEdit: () => void;
  onShare: () => void;
  onAssign: () => void;
  onRetire: () => void;
}) {
  const reached = l.total ? Math.round((l.called / l.total) * 100) : 0;
  const anyFilter = l.batch_filename || l.tag || l.preacher_code || l.city || l.min_external_total || l.status_slug || l.source;

  return (
    <Card padded={false} className={`flex flex-col p-4 sm:p-5 ${l.active ? "" : "opacity-60"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink">{l.name}</h2>
          <p className="mt-0.5 text-2xs text-ink-muted">
            {l.origin === "import" ? "From a sheet" : "Made by hand"}
            {l.created_by_name && ` · ${l.created_by_name}`}
            {` · ${relativeDate(l.created_at)}`}
          </p>
        </div>
        <div className="flex flex-none flex-wrap justify-end gap-1">
          {l.assigned_to_me && <Badge tone="brand">Yours</Badge>}
          {!l.active && <Badge>Retired</Badge>}
        </div>
      </div>

      {l.description && <p className="mt-2 line-clamp-2 text-sm text-ink-soft">{l.description}</p>}
      {l.assigned_to_me && l.assignment_note && (
        <p className="mt-2 rounded-control bg-brand-50 px-2.5 py-1.5 text-xs text-brand-800">{l.assignment_note}</p>
      )}

      <div className="mt-3 flex flex-wrap gap-1">
        {l.members_only ? (
          <Badge tone="info">Hand-picked</Badge>
        ) : (
          <>
            {l.batch_filename && <Badge>{l.batch_sheet || l.batch_filename}</Badge>}
            {l.tag && <Badge>#{l.tag}</Badge>}
            {l.preacher_code && <Badge>{l.preacher_name || l.preacher_code}</Badge>}
            {l.city && <Badge>{l.city}</Badge>}
            {l.status_slug && <Badge>{l.status_slug.replace(/_/g, " ")}</Badge>}
            {l.source && <Badge>{SOURCES.find((s) => s.key === l.source)?.label ?? l.source}</Badge>}
            {l.min_external_total && <Badge>over {currency(Number(l.min_external_total))}</Badge>}
            {!anyFilter && <span className="text-xs text-ink-faint">Everyone</span>}
          </>
        )}
      </div>

      <div className="mt-4 flex items-end gap-6">
        <div>
          <p className="text-2xl font-semibold tabular-nums text-ink">{number(l.to_call)}</p>
          <p className="text-xs text-ink-muted">{elevated ? "for you" : "to call"}</p>
        </div>
        {elevated && (
          <div>
            <p className="text-lg font-semibold tabular-nums text-ink-soft">{number(l.to_call_all)}</p>
            <p className="text-xs text-ink-muted">for the team</p>
          </div>
        )}
      </div>

      {elevated && (
        <div className="mt-3">
          <div
            className="h-1.5 overflow-hidden rounded-pill bg-sunken"
            role="progressbar"
            aria-label="Called so far"
            aria-valuenow={reached}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-full rounded-pill bg-brand-500" style={{ width: `${reached}%` }} />
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {number(l.called)} of {plural(l.total, "person", "people")} called
            {l.converted > 0 && ` · ${number(l.converted)} donated`}
          </p>
        </div>
      )}

      {(l.added_by_hand > 0 || l.left_out > 0) && (
        <p className="mt-2 text-xs text-ink-muted">
          {[l.added_by_hand > 0 && `${number(l.added_by_hand)} added by hand`, l.left_out > 0 && `${number(l.left_out)} left out`]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      <div className="mt-auto grid grid-cols-2 gap-2 pt-4 sm:flex sm:flex-wrap">
        <Button
          icon={l.session_id ? "arrowRight" : "phoneOutgoing"}
          loading={starting}
          onClick={onStart}
          className="col-span-2 sm:col-span-1"
        >
          {l.session_id
            ? `Continue (${plural(l.session_calls ?? 0, "call", "calls")})`
            : "Start calling"}
        </Button>
        {/* callable=true: the same people a run would hand over, not
            everyone the list has ever held. */}
        <Link
          href={`/leads?list=${l.id}&callable=true`}
          className={buttonClass("secondary", "md", elevated ? "" : "col-span-2 sm:col-span-1")}
        >
          See leads
        </Link>
        {elevated && (
          <DropdownMenu
            className="min-w-0"
            items={[
              { label: "Edit", icon: "edit", onSelect: onEdit },
              { label: "Split between callers", icon: "users", onSelect: onShare },
              { label: "Give to callers", icon: "userPlus", onSelect: onAssign },
              l.active
                ? { label: "Retire", icon: "trash", hint: "Hide from callers", onSelect: onRetire, tone: "danger" as const }
                : { label: "Bring back", icon: "refresh", onSelect: onRetire },
            ]}
            trigger={({ open, toggle }) => (
              <Button
                variant="secondary"
                icon="settings"
                iconRight="chevronDown"
                onClick={toggle}
                aria-expanded={open}
                aria-haspopup="menu"
                className="w-full sm:w-auto"
              >
                Manage
              </Button>
            )}
          />
        )}
      </div>
      {l.session_id && l.session_last_active && (
        <p className="mt-2 text-2xs text-ink-faint">Last called {relativeDate(l.session_last_active).toLowerCase()}</p>
      )}
    </Card>
  );
}

/* ------------------------------------------------------- shared pickers */

/**
 * How many people a set of filters finds, while the form is being filled in.
 *
 * Counted by GET /lists/preview, which runs the same SQL a saved list uses,
 * so the number on the form is the number the list will have. Debounced: the
 * city box would otherwise count once per letter.
 */
function useListPreview(f: ListFilters, enabled = true) {
  const qs = new URLSearchParams(
    Object.entries(f)
      .map(([k, v]) => [k, String(v).trim()])
      .filter(([, v]) => v)
  ).toString();
  const [result, setResult] = useState<{ key: string; total: number; to_call: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const latest = useRef("");

  useEffect(() => {
    if (!enabled) return;
    latest.current = qs;
    const t = setTimeout(() => {
      apiClient.get<{ total: number; to_call: number }>(`/api/crm/lists/preview?${qs}`).then(
        (d) => {
          if (latest.current === qs) setResult({ key: qs, total: d.total, to_call: d.to_call });
        },
        () => {
          if (latest.current === qs) setFailed(qs);
        }
      );
    }, 400);
    return () => clearTimeout(t);
  }, [qs, enabled]);

  return {
    result,
    counting: enabled && result?.key !== qs && failed !== qs,
    failed: failed === qs,
  };
}

function PreviewLine({ preview }: { preview: ReturnType<typeof useListPreview> }) {
  const { result, counting, failed } = preview;
  return (
    <p className="mt-3 flex items-center gap-2 rounded-control bg-sunken px-3 py-2 text-sm text-ink" aria-live="polite">
      {failed ? (
        <span className="text-ink-muted">Could not count.</span>
      ) : result ? (
        <span className={counting ? "opacity-50" : ""}>
          <strong className="tabular-nums">{plural(result.total, "person", "people")}</strong> ·{" "}
          <strong className="tabular-nums">{number(result.to_call)}</strong> to call now
        </span>
      ) : (
        <span className="text-ink-muted">Counting…</span>
      )}
      {counting && result && <span className="text-xs text-ink-faint">counting…</span>}
    </p>
  );
}

/**
 * Who is in a list. Every field is optional and they narrow together, so one
 * form covers "the March sheet" and "the March sheet, Vizag, over a lakh"
 * without needing a different kind of list for each. Shared by building and
 * editing, so the two cannot offer different choices.
 */
function ListFilterFields({
  value,
  onChange,
  preachers,
  batches,
  statuses,
}: {
  value: ListFilters;
  onChange: (next: ListFilters) => void;
  preachers: Preacher[];
  batches: Batch[];
  statuses: Status[];
}) {
  const set = (k: keyof ListFilters) => (v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Sheet">
        <Select
          value={value.import_batch_id}
          onChange={set("import_batch_id")}
          ariaLabel="Sheet"
          placeholder="Any sheet"
          options={[
            { value: "", label: "Any sheet" },
            ...batches.map((b) => ({
              value: b.id,
              label: b.sheet_name ? `${b.filename} · ${b.sheet_name}` : b.filename,
            })),
          ]}
        />
      </Field>
      <Field label="Tag" htmlFor="list-tag">
        <Input
          id="list-tag"
          value={value.tag}
          onChange={(e) => set("tag")(e.target.value)}
          placeholder="Any tag"
          autoCapitalize="off"
        />
      </Field>
      <Field label="Preacher">
        <Select
          value={value.preacher_id}
          onChange={set("preacher_id")}
          ariaLabel="Preacher"
          placeholder="Any preacher"
          options={[
            { value: "", label: "Any preacher" },
            ...preachers.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.code})` : p.code })),
          ]}
        />
      </Field>
      <Field label="Stage">
        <Select
          value={value.status_slug}
          onChange={set("status_slug")}
          ariaLabel="Stage"
          placeholder="Any stage"
          options={[{ value: "", label: "Any stage" }, ...statuses.map((s) => ({ value: s.slug, label: s.label }))]}
        />
      </Field>
      <Field label="Source">
        <Select
          value={value.source}
          onChange={set("source")}
          ariaLabel="Source"
          placeholder="Any source"
          options={[{ value: "", label: "Any source" }, ...SOURCES.map((s) => ({ value: s.key, label: s.label }))]}
        />
      </Field>
      <Field label="City" htmlFor="list-city">
        <Input id="list-city" value={value.city} onChange={(e) => set("city")(e.target.value)} placeholder="Any city" />
      </Field>
      <Field label="Total given, at least (₹)" htmlFor="list-min" className="sm:col-span-2">
        <Input
          id="list-min"
          value={value.min_external_total}
          onChange={(e) => set("min_external_total")(e.target.value.replace(/[^\d]/g, ""))}
          placeholder="Any amount"
          inputMode="numeric"
          className="tabular-nums"
        />
      </Field>
    </div>
  );
}

const isEmpty = (f: ListFilters) => !Object.values(f).some((v) => String(v).trim());

/* ------------------------------------------------------------ new list */

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
  const [filters, setFilters] = useState<ListFilters>(NO_FILTERS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The live count underneath is what stops somebody saving a list that
  // turns out to select nobody - or everybody.
  const preview = useListPreview(filters);

  async function save() {
    if (!name.trim()) return setError("Enter a list name.");
    setBusy(true);
    setError(null);
    try {
      await apiClient.post("/api/crm/lists", {
        name: name.trim(),
        import_batch_id: filters.import_batch_id || undefined,
        tag: filters.tag.trim() || undefined,
        preacher_id: filters.preacher_id || undefined,
        status_slug: filters.status_slug || undefined,
        source: filters.source || undefined,
        city: filters.city.trim() || undefined,
        min_external_total: filters.min_external_total || undefined,
      });
      toast(`List “${name.trim()}” made`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New list"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !name.trim()} loading={busy}>
            {busy ? "Saving…" : "Create list"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <Field label="List name" htmlFor="list-name" required>
        <Input
          id="list-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Janmashtami lapsed donors"
        />
      </Field>

      <p className="mb-2 mt-4 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Who is in it</p>
      <ListFilterFields
        value={filters}
        onChange={setFilters}
        preachers={preachers}
        batches={batches}
        statuses={statuses}
      />
      <PreviewLine preview={preview} />

      {isEmpty(filters) && (
        <Alert tone="warn" className="mb-0 mt-3">
          Nothing picked. This list will have every lead.
        </Alert>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------- edit list */

interface Member {
  lead_id: string;
  kind: "include" | "exclude";
  name: string | null;
  phone: string;
  added_by_name: string | null;
  created_at: string;
}

/**
 * Changing a list after it is made.
 *
 * The filters used to be fixed at creation, so a list built on the wrong city
 * had to be retired and rebuilt - and everybody lost their place in it. Now
 * everything is editable in place, with the same live count as building one.
 */
function EditListDialog({
  list,
  preachers,
  batches,
  statuses,
  onClose,
  onDone,
}: {
  list: CallingList;
  preachers: Preacher[];
  batches: Batch[];
  statuses: Status[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(list.name);
  const [description, setDescription] = useState(list.description ?? "");
  const [active, setActiveState] = useState(list.active);
  const [membersOnly, setMembersOnly] = useState(list.members_only);
  const [filters, setFilters] = useState<ListFilters>({
    import_batch_id: list.import_batch_id ?? "",
    tag: list.tag ?? "",
    preacher_id: list.preacher_id ?? "",
    status_slug: list.status_slug ?? "",
    source: list.source ?? "",
    city: list.city ?? "",
    // Arrives as numeric text ("100000.00"); the box wants whole rupees.
    min_external_total: list.min_external_total ? String(Math.round(Number(list.min_external_total))) : "",
  });
  const [members, setMembers] = useState<Member[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useListPreview(filters, !membersOnly);

  const loadMembers = useCallback(
    () =>
      apiClient
        .get<{ members: Member[] }>(`/api/crm/lists/${list.id}/members`)
        .then((d) => setMembers(d.members), (e) => setError(e instanceof Error ? e.message : "Could not load. Try again.")),
    [list.id]
  );

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  async function removeMember(m: Member) {
    setRemoving(m.lead_id);
    try {
      await apiClient.post(`/api/crm/lists/${list.id}/members`, { lead_ids: [m.lead_id], action: "remove" });
      setMembers((all) => (all ? all.filter((x) => x.lead_id !== m.lead_id) : all));
      toast(
        m.kind === "include"
          ? `Removed ${m.name || m.phone}`
          : `${m.name || m.phone} follows the filters again`
      );
    } catch (e) {
      toast.error("Could not save. Try again.", e instanceof Error ? e.message : undefined);
    } finally {
      setRemoving(null);
    }
  }

  async function save() {
    if (!name.trim()) return setError("Enter a list name.");
    setBusy(true);
    setError(null);
    try {
      // Every field is sent, "" for "any": the server clears a field sent
      // empty and leaves one not sent alone, so sending all of them is what
      // makes clearing a filter on this form actually clear it.
      await apiClient.put(`/api/crm/lists/${list.id}`, {
        name: name.trim(),
        description: description.trim(),
        active,
        members_only: membersOnly,
        import_batch_id: filters.import_batch_id,
        tag: filters.tag.trim(),
        preacher_id: filters.preacher_id,
        status_slug: filters.status_slug,
        source: filters.source,
        city: filters.city.trim(),
        min_external_total: filters.min_external_total,
      });
      toast(`Saved “${name.trim()}”`);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      setBusy(false);
    }
  }

  const included = members?.filter((m) => m.kind === "include") ?? [];
  const excluded = members?.filter((m) => m.kind === "exclude") ?? [];

  return (
    <Modal
      title={`Edit ${list.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={busy} disabled={!name.trim()}>
            Save
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="edit-list-name" required>
          <Input id="edit-list-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-3 rounded-control border border-line-soft px-3 py-2 sm:mt-5">
          <span className="text-sm text-ink-soft">
            {active ? "Shown to callers" : "Hidden from callers"}
          </span>
          <Toggle on={active} onChange={setActiveState} label="List is active" />
        </div>
        <Field label="Note (optional)" htmlFor="edit-list-desc" className="sm:col-span-2">
          <Textarea
            id="edit-list-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Call before 15 August"
          />
        </Field>
      </div>

      <p className="mb-2 mt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">Who is in it</p>
      <Checkbox
        checked={membersOnly}
        onChange={setMembersOnly}
        label="Only people added by hand"
        className="mb-3"
      />
      {membersOnly ? (
        <p className="rounded-control bg-sunken px-3 py-2 text-sm text-ink">
          {plural(included.length, "person", "people")} added by hand.
        </p>
      ) : (
        <>
          <ListFilterFields
            value={filters}
            onChange={setFilters}
            preachers={preachers}
            batches={batches}
            statuses={statuses}
          />
          <PreviewLine preview={preview} />
          {included.length > 0 && (
            <p className="mt-1.5 text-xs text-ink-muted">
              Plus {plural(included.length, "person", "people")} added by hand
              {excluded.length > 0 && ` · ${number(excluded.length)} left out`}
            </p>
          )}
        </>
      )}

      <p className="mb-2 mt-5 text-2xs font-semibold uppercase tracking-[0.08em] text-ink-muted">
        People added by hand
      </p>
      {members === null ? (
        <Skeleton className="h-16 w-full" />
      ) : !members.length ? (
        <p className="text-sm text-ink-muted">No one yet.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line-soft overflow-y-auto rounded-card border border-line-soft scroll-slim">
          {[...included, ...excluded].map((m) => (
            <li key={m.lead_id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-ink">
                  {m.name || "No name"}{" "}
                  <span className="text-xs tabular-nums text-ink-muted">{m.phone}</span>
                </p>
                <p className="text-2xs text-ink-faint">
                  {m.kind === "include" ? "Added" : "Left out"}
                  {m.added_by_name && ` by ${m.added_by_name}`} · {relativeDate(m.created_at).toLowerCase()}
                </p>
              </div>
              {m.kind === "exclude" && <Badge tone="warn">Left out</Badge>}
              <Button
                variant="ghost"
                size="sm"
                icon="x"
                loading={removing === m.lead_id}
                onClick={() => void removeMember(m)}
                title={m.kind === "include" ? "Remove from list" : "Use filters again"}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- share out */

/**
 * Dealing a list's people out between callers.
 *
 * Round-robin in the order the queue would ring them, so everybody gets a
 * fair share of the urgent ones rather than one person getting every overdue
 * promise. Leads a colleague already has are left with them unless asked:
 * taking somebody's work off them is a decision, not a side effect.
 */
function SplitDialog({
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
  const callers = users.filter((u) => u.role === "caller" || u.role === "admin");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [includeAssigned, setIncludeAssigned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deal() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ dealt: number; shares: { user_id: string; name: string | null; count: number }[] }>(
        `/api/crm/lists/${list.id}/split`,
        { user_ids: [...chosen], include_assigned: includeAssigned }
      );
      if (!r.dealt) {
        toast.info(
          "No one to split",
          includeAssigned
            ? "No one on this list can be called."
            : "Everyone already has a caller."
        );
      } else {
        toast(`Split ${number(r.dealt)}: ${r.shares.map((s) => `${s.name ?? "?"} ${number(s.count)}`).join(", ")}`);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not split. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Split ${list.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void deal()} loading={busy} disabled={!chosen.size}>
            {chosen.size ? `Split between ${plural(chosen.size, "caller", "callers")}` : "Pick callers"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="mb-3 text-sm text-ink-muted">{number(list.to_call_all)} to call now.</p>

      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-soft">Callers</p>
        <Button
          variant="ghost"
          size="xs"
          onClick={() =>
            setChosen(chosen.size === callers.length ? new Set() : new Set(callers.map((u) => u.id)))
          }
        >
          {chosen.size === callers.length ? "Untick all" : "Tick all"}
        </Button>
      </div>
      <div className="max-h-64 space-y-1 overflow-y-auto scroll-slim">
        {callers.map((u) => (
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
        {!callers.length && <p className="text-sm text-ink-muted">No callers yet.</p>}
      </div>

      <div className="mt-4 rounded-control border border-line-soft p-3">
        <Checkbox
          checked={includeAssigned}
          onChange={setIncludeAssigned}
          label="Also move leads that have a caller"
        />
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- give to */

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
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load. Try again."));
  }, [list.id]);

  return (
    <Modal
      title={`Who should call ${list.name}?`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
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
                toast(
                  chosen.size
                    ? `Gave “${list.name}” to ${plural(chosen.size, "caller", "callers")}`
                    : `“${list.name}” has no callers now`
                );
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save. Try again.");
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

      <Field label="Note (optional)" htmlFor="assign-note" className="mt-4">
        <Input
          id="assign-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. Finish by Friday"
        />
      </Field>
    </Modal>
  );
}
