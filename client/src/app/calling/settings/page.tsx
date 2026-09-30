"use client";

// Calling settings.
//
// Two things are editable here, and they are the two that differ between
// temples and between campaigns:
//
//   The STAGES a lead moves through. Whether a stage counts as won or lost is
//   what every report keys off, so a stage invented next month is counted
//   correctly the moment it is created - no code change, no report to rewrite.
//
//   The CALL OUTCOMES. Whether an outcome counts as "got through" decides the
//   connected/unanswered split; what status it suggests is what makes one tap
//   enough on the calling screen; and whether it asks for a callback is what
//   keeps unanswered leads from disappearing.
//
// Nothing here can be deleted, on purpose. Leads and calls already recorded
// against a stage or outcome would be orphaned by a delete, so retiring it
// (switch it off) removes it from the dropdowns while old records keep their
// meaning.

import { Fragment, useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { Badge, buttonPrimary, buttonSecondary, Card, CardHeader, inputClass, PageHeader, Select, TableShell, Td, Th, Toggle, Modal } from "@/components/ui";
import { apiClient as api } from "@/lib/api";
import { currency, number } from "@/lib/format";

interface Status {
  slug: string;
  label: string;
  tone: string;
  sort_order: number;
  is_won: boolean;
  is_lost: boolean;
  is_open: boolean;
  active: boolean;
}

interface Disposition {
  slug: string;
  label: string;
  counts_connected: boolean;
  suggests_status: string | null;
  wants_follow_up: boolean;
  sort_order: number;
  active: boolean;
}

interface Config {
  statuses: Status[];
  dispositions: Disposition[];
  settings: Record<string, unknown>;
  users: { id: string; name: string }[];
}

// Each setting explained where it is edited, not in a manual nobody opens.
const SETTING_COPY: Record<string, { label: string; help: string; kind: "number" | "boolean" | "hours" }> = {
  queue_batch_size: {
    label: "Leads loaded at a time",
    help: "How many the calling screen fetches in one go. Higher means fewer pauses mid-run.",
    kind: "number",
  },
  retry_after_days: {
    label: "Days before trying an unanswered lead again",
    help: "When a call goes unanswered and no date is set, the lead comes back round after this many days.",
    kind: "number",
  },
  max_attempts: {
    label: "Attempts before parking a lead",
    help: "After this many tries the lead drops out of the queue instead of being dialled forever. It is not deleted.",
    kind: "number",
  },
  stale_lead_days: {
    label: "Days before an untouched lead resurfaces",
    help: "A lead nobody has contacted for this long moves back towards the top of the queue.",
    kind: "number",
  },
  callers_see_all_leads: {
    label: "Callers can see everyone's leads",
    help: "Off means a caller's queue only holds leads assigned to them, plus unassigned ones.",
    kind: "boolean",
  },
};

export default function CallingSettingsPage() {
  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newStage, setNewStage] = useState("");

  const load = useCallback(async () => {
    try {
      setConfig(await apiClient.get<Config>("/api/crm/config"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load settings");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSetting(key: string, value: unknown) {
    setSaving(key);
    try {
      await apiClient.put(`/api/crm/settings/${key}`, { value });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
    } finally {
      setSaving(null);
    }
  }

  async function saveStatus(slug: string, body: Record<string, unknown>) {
    setSaving(slug);
    try {
      await apiClient.put(`/api/crm/statuses/${slug}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that stage");
    } finally {
      setSaving(null);
    }
  }

  async function saveDisposition(slug: string, body: Record<string, unknown>) {
    setSaving(slug);
    try {
      await apiClient.put(`/api/crm/dispositions/${slug}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that outcome");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title="Calling settings" subtitle="How the queue behaves, and the words your team uses" />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      <div className="space-y-6">
        {/* ---------------------------------------------------- how it works */}
        <Card>
          <CardHeader title="How the queue behaves" />
          <div className="space-y-4">
            {Object.entries(SETTING_COPY).map(([key, meta]) => {
              const value = config?.settings[key];
              return (
                <div key={key} className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4 last:border-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-900">{meta.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{meta.help}</p>
                  </div>
                  {meta.kind === "boolean" ? (
                    <button
                      disabled={saving === key}
                      onClick={() => void saveSetting(key, !value)}
                      className={value ? buttonPrimary : buttonSecondary}
                    >
                      {value ? "On" : "Off"}
                    </button>
                  ) : (
                    <input
                      type="number"
                      min={1}
                      defaultValue={String(value ?? "")}
                      onBlur={(e) => Number(e.target.value) !== Number(value) && void saveSetting(key, Number(e.target.value))}
                      className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-sm tabular-nums"
                    />
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        {/* --------------------------------------------------------- stages */}
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader
              title="Stages"
              subtitle="Where a lead can be. Won and lost are what the conversion reports count; open decides whether it stays in the queue."
            />
          </div>
          <TableShell>
            <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
              <tr>
                <Th>Stage</Th>
                <Th align="center">Counts as won</Th>
                <Th align="center">Counts as lost</Th>
                <Th align="center">Stays in queue</Th>
                <Th align="center">In use</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {config?.statuses.map((s) => (
                <tr key={s.slug} className="hover:bg-slate-50/60">
                  <Td>
                    <input
                      defaultValue={s.label}
                      onBlur={(e) => e.target.value !== s.label && void saveStatus(s.slug, { label: e.target.value })}
                      className="w-full bg-transparent font-medium text-slate-900 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                    />
                    <span className="text-[11px] text-slate-400">{s.slug}</span>
                  </Td>
                  <Td align="center"><Toggle on={s.is_won} onChange={(v) => void saveStatus(s.slug, { is_won: v })} /></Td>
                  <Td align="center"><Toggle on={s.is_lost} onChange={(v) => void saveStatus(s.slug, { is_lost: v })} /></Td>
                  <Td align="center"><Toggle on={s.is_open} onChange={(v) => void saveStatus(s.slug, { is_open: v })} /></Td>
                  <Td align="center"><Toggle on={s.active} onChange={(v) => void saveStatus(s.slug, { active: v })} /></Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
          <div className="px-5 py-4 flex gap-2 border-t border-[var(--line-soft)]">
            <input
              value={newStage}
              onChange={(e) => setNewStage(e.target.value)}
              placeholder="Add a stage, e.g. Will give after Kartik"
              className={`${inputClass} w-full`}
            />
            <button
              disabled={!newStage.trim()}
              onClick={() => {
                const slug = newStage.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
                void saveStatus(slug, { label: newStage.trim(), sort_order: 55, is_open: true, active: true });
                setNewStage("");
              }}
              className={buttonPrimary}
            >
              Add
            </button>
          </div>
        </Card>

        {/* -------------------------------------------------- call outcomes */}
        <Card padded={false}>
          <div className="px-5 pt-5">
            <CardHeader
              title="Call outcomes"
              subtitle="What a caller taps after a call. The stage it suggests is what makes one tap enough."
            />
          </div>
          <TableShell>
            <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
              <tr>
                <Th>Outcome</Th>
                <Th align="center">Counts as got through</Th>
                <Th>Moves the lead to</Th>
                <Th align="center">Books a callback</Th>
                <Th align="center">In use</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {config?.dispositions.map((d) => (
                <tr key={d.slug} className="hover:bg-slate-50/60">
                  <Td>
                    <input
                      defaultValue={d.label}
                      onBlur={(e) => e.target.value !== d.label && void saveDisposition(d.slug, { label: e.target.value })}
                      className="w-full bg-transparent font-medium text-slate-900 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                    />
                  </Td>
                  <Td align="center">
                    <Toggle on={d.counts_connected} onChange={(v) => void saveDisposition(d.slug, { counts_connected: v })} />
                  </Td>
                  <Td>
                    <Select
                      value={d.suggests_status ?? ""}
                      onChange={(v) => void saveDisposition(d.slug, { suggests_status: v || null })}
                      className="min-w-[9rem]"
                    >
                      <option value="">Leave it alone</option>
                      {config?.statuses.map((s) => (
                        <option key={s.slug} value={s.slug}>{s.label}</option>
                      ))}
                    </Select>
                  </Td>
                  <Td align="center">
                    <Toggle on={d.wants_follow_up} onChange={(v) => void saveDisposition(d.slug, { wants_follow_up: v })} />
                  </Td>
                  <Td align="center"><Toggle on={d.active} onChange={(v) => void saveDisposition(d.slug, { active: v })} /></Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </Card>

        {/* ------------------------------------------------------ preachers */}
        <PreachersSection />

        {/* --------------------------------------------------------- QR codes */}
        <QrSection />

        {/* ---------------------------------------------------------- links */}
        <LinksSection />

        {/* ------------------------------------------------ what is not here */}
        <Card>
          <CardHeader title="Call recording and automatic call logs" />
          <p className="text-sm text-slate-600">
            Calls are made from callers&apos; own phones, so DRM records what they tell it afterwards — there is
            nothing to switch on here for recording, call duration or automatic connected/unanswered detection.
          </p>
          <p className="mt-2 text-sm text-slate-600">
            Those become real measurements only with a cloud telephony provider (Exotel, MyOperator, Knowlarity and
            Twilio all work this way): the caller presses call in DRM, the provider dials both numbers, and its
            webhook sends back the duration, whether it connected and a recording link. The call log already has
            columns for all of that, so connecting one later needs no change to the database and no report rewritten
            — only the dialling itself.
          </p>
        </Card>
      </div>
    </div>
  );
}

/**
 * Preachers.
 *
 * The codes come out of the office's sheets - "Enrolled By" - and DRM creates
 * any it has not seen during an import, so this list fills itself. What it
 * cannot do is know what JTMD stands for, which is the one thing a caller
 * actually needs: "Jagat Tarini Mataji gave us your name" opens a call in a way
 * that "JTMD" never will.
 *
 * The counts are what make this worth opening. A preacher list without them is
 * an admin screen; with them it answers "whose donors should we be calling",
 * which is the question the office has.
 */
interface PreacherRow {
  id: string;
  code: string;
  name: string | null;
  phone: string | null;
  id_number: string | null;
  active: boolean;
  leads: number;
  open_leads: number;
  converted: number;
  raised: string;
  external_total: string;
  donors: number;
}

function PreachersSection() {
  const [rows, setRows] = useState<PreacherRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ preachers: PreacherRow[] }>(
        `/api/crm/preachers${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`
      );
      setRows(d.preachers);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the preachers");
    }
  }, [q]);

  useEffect(() => {
    // Debounced, so typing a name does not fire a request per keystroke.
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  async function save(id: string, body: Record<string, unknown>) {
    setError(null);
    try {
      await api.put(`/api/crm/preachers/${id}`, body);
      await load();
    } catch (e) {
      // Nearly always a duplicate ID number, and the server's message names
      // who already has it - so it is shown as it came back rather than
      // replaced with something vaguer.
      setError(e instanceof Error ? e.message : "Could not save that");
      await load();
    }
  }

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <CardHeader
          title={`Preachers${rows.length ? ` · ${rows.length}` : ""}`}
          subtitle="The Enrolled By codes from your sheets. Give them real names and every caller sees the name instead of the code."
        />
        <div className="flex flex-wrap gap-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code or ID…"
            className={`${inputClass} w-52`}
          />
          <button onClick={() => setAdding(true)} className={buttonPrimary}>
            Add a preacher
          </button>
        </div>
      </div>

      {error && <p className="px-5 pb-3 text-sm text-red-700">{error}</p>}

      <TableShell>
        <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
          <tr>
            <Th>Code</Th>
            <Th>Name</Th>
            <Th>ID number</Th>
            <Th align="right">Leads</Th>
            <Th align="right">Still to call</Th>
            <Th align="right">In temple accounts</Th>
            <Th align="right">Raised by calling</Th>
            <Th align="center">In use</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {!rows.length ? (
            <tr>
              <td colSpan={8} className="px-4 py-8 text-center text-sm text-slate-400">
                {q.trim()
                  ? `Nothing matches “${q.trim()}”.`
                  : "None yet — add one, or upload a sheet with an Enrolled By column and they appear on their own."}
              </td>
            </tr>
          ) : (
            rows.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50/60">
                <Td className="font-medium text-slate-900 tabular-nums">{p.code}</Td>
                <Td>
                  <input
                    defaultValue={p.name ?? ""}
                    placeholder="Their name…"
                    onBlur={(e) => e.target.value !== (p.name ?? "") && void save(p.id, { name: e.target.value })}
                    className="w-full bg-transparent text-slate-800 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                  />
                </Td>
                <Td>
                  {/* Typed in, never generated. A number DRM invented would
                      look identical on screen to one the office issued, and
                      afterwards nobody could tell which was which. */}
                  <input
                    defaultValue={p.id_number ?? ""}
                    placeholder="—"
                    onBlur={(e) =>
                      e.target.value.trim().toUpperCase() !== (p.id_number ?? "") &&
                      void save(p.id, { id_number: e.target.value })
                    }
                    className="w-24 bg-transparent tabular-nums text-slate-700 placeholder:text-slate-300 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                  />
                </Td>
                <Td align="right" className="tabular-nums text-slate-600">{number(p.leads)}</Td>
                <Td align="right" className="tabular-nums text-slate-600">{number(p.open_leads)}</Td>
                <Td align="right" className="tabular-nums text-slate-700">
                  {Number(p.external_total) ? currency(Number(p.external_total)) : <span className="text-slate-300">—</span>}
                </Td>
                <Td align="right" className="tabular-nums font-medium text-slate-900">
                  {Number(p.raised) ? currency(Number(p.raised)) : <span className="text-slate-300">—</span>}
                </Td>
                <Td align="center"><Toggle on={p.active} onChange={(v) => void save(p.id, { active: v })} /></Td>
              </tr>
            ))
          )}
        </tbody>
      </TableShell>

      <div className="border-t border-[var(--line-soft)] px-5 py-4">
        <p className="text-xs text-slate-500">
          A preacher is somebody the DONOR knows, not somebody who signs in to DRM — which is why this is a separate
          list from your team. Retiring one keeps every donor they brought in; it only takes the code out of the
          dropdowns. Name and ID number can be edited straight in the table.
        </p>
      </div>

      {adding && (
        <AddPreacherDialog
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Adding a preacher by hand.
 *
 * The code is the only required field, because the code is what a sheet
 * carries and what an import matches on — a preacher with a name and no code
 * would never be found again when the next export arrives. The name and the
 * ID number are what make the row useful to a human.
 */
function AddPreacherDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="Add a preacher" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          Their name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jagat Tarini Mataji"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Short form (code) <span className="text-red-600">*</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s+/g, ""))}
            placeholder="e.g. JTMD"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
        <label className="text-xs text-slate-500">
          ID number
          <input
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value)}
            placeholder="e.g. 1042 or HKM-118"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Phone (optional)
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            className={`${inputClass} mt-1 w-full tabular-nums`}
          />
        </label>
      </div>

      <p className="mt-3 text-xs text-slate-500">
        The code has to match what your sheets put in the <strong>Enrolled By</strong> column — that is how an upload
        recognises them. The ID number is your own register&apos;s; DRM stores it and never makes one up.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy || !code.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api.post("/api/crm/preachers", {
                code: code.trim(),
                name: name.trim() || undefined,
                id_number: idNumber.trim() || undefined,
                phone: phone.trim() || undefined,
              });
              onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save that preacher");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Add them"}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The links callers send on WhatsApp.
 *
 * Here rather than only on the calling screen because this is where the temple
 * decides what the team offers - a new festival page should appear in every
 * caller's dropdown the moment someone adds it, without a deploy.
 */
interface LinkRow {
  id: string;
  label: string;
  url: string;
  seva_name: string | null;
  message: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  sort_order: number;
  active: boolean;
  use_count: number;
}

function LinksSection() {
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<{ links: LinkRow[] }>("/api/crm/links/all");
      setLinks(d.links);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the links");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(id: string, body: Record<string, unknown>) {
    try {
      await api.put(`/api/crm/links/${id}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that link");
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Delete "${label}"? Callers will no longer be able to send it.`)) return;
    try {
      await api.delete(`/api/crm/links/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete that link");
    }
  }

  return (
    <Card padded={false}>
      <div className="px-5 pt-5">
        <CardHeader
          title="Links callers can send"
          subtitle="Picked on the calling screen and sent straight into the donor's WhatsApp. Editing one changes it for everybody."
        />
      </div>

      {error && <p className="px-5 pb-3 text-sm text-red-700">{error}</p>}

      <TableShell>
        <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
          <tr>
            <Th className="w-1/3">Name</Th>
            <Th>Link</Th>
            <Th align="right">Sent</Th>
            <Th align="center">Shared</Th>
            <Th align="center">In use</Th>
            <Th align="right"><span className="sr-only">Actions</span></Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {!links.length ? (
            <tr>
              <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-400">
                No links saved yet.
              </td>
            </tr>
          ) : (
            links.map((l) => (
              // A fragment, because a link in edit mode renders two <tr>s and
              // they cannot be wrapped in a <div> inside a <tbody>. The key
              // belongs on the fragment, not on the rows inside it.
              <Fragment key={l.id}>
                <tr className="hover:bg-slate-50/60">
                  <Td>
                    <input
                      defaultValue={l.label}
                      onBlur={(e) => e.target.value !== l.label && void save(l.id, { label: e.target.value })}
                      className="w-full bg-transparent font-medium text-slate-900 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                    />
                    {l.seva_name && <span className="text-[11px] text-slate-400">{l.seva_name}</span>}
                  </Td>
                  <Td className="max-w-[16rem]">
                    <span className="block truncate text-xs text-slate-500" title={l.url}>
                      {l.url}
                    </span>
                  </Td>
                  <Td align="right" className="tabular-nums text-sm text-slate-600">
                    {l.use_count || <span className="text-slate-300">0</span>}
                  </Td>
                  <Td align="center">
                    {l.owner_user_id ? (
                      <Badge tone="neutral">{l.owner_name ?? "private"}</Badge>
                    ) : (
                      <Badge tone="good">everyone</Badge>
                    )}
                  </Td>
                  <Td align="center">
                    <Toggle on={l.active} onChange={(v) => void save(l.id, { active: v })} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <button
                      onClick={() => setEditing(editing === l.id ? null : l.id)}
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      {editing === l.id ? "Close" : "Edit"}
                    </button>
                    <button
                      onClick={() => void remove(l.id, l.label)}
                      className="ml-3 text-xs text-red-600 hover:underline"
                    >
                      Delete
                    </button>
                  </Td>
                </tr>
                {editing === l.id && (
                  <tr>
                    <td colSpan={6} className="bg-slate-50 px-4 py-3">
                      <label className="block mb-2">
                        <span className="block text-xs text-slate-500 mb-1">Link</span>
                        <input
                          defaultValue={l.url}
                          onBlur={(e) => e.target.value !== l.url && void save(l.id, { url: e.target.value })}
                          className={`${inputClass} w-full text-xs`}
                        />
                      </label>
                      <label className="block">
                        <span className="block text-xs text-slate-500 mb-1">
                          Message — {"{name}"} {"{seva}"} {"{link}"} {"{amount}"} are filled in for each donor
                        </span>
                        <textarea
                          defaultValue={l.message ?? ""}
                          onBlur={(e) => e.target.value !== (l.message ?? "") && void save(l.id, { message: e.target.value })}
                          rows={4}
                          className={`${inputClass} w-full text-xs resize-y`}
                        />
                      </label>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))
          )}
        </tbody>
      </TableShell>

      <p className="px-5 py-4 text-xs text-slate-500 border-t border-[var(--line-soft)]">
        These go out from the caller&apos;s own WhatsApp, so there is no Meta template to approve and nothing to pay
        per message. DRM opens the chat with the text ready — the caller still presses send, which is why the
        history says &ldquo;opened WhatsApp&rdquo; rather than claiming it was delivered.
      </p>
    </Card>
  );
}



/**
 * The Razorpay QR codes callers can share.
 *
 * The QRs themselves are made in the Razorpay dashboard - DRM does not mint
 * them and needs no API key to hand one to a donor. What it needs is the id,
 * so a payment reported later can be traced back to the call that produced it.
 *
 * Assigning one to a caller is what makes a donation creditable. Without an
 * owner a QR is the temple's, offered to everybody, and a payment through it
 * can still be matched to a lead but not to a person's work.
 */
interface QrRow {
  id: string;
  qr_id: string;
  label: string;
  image_url: string | null;
  purpose: string | null;
  fixed_amount: string | null;
  owner_id: string | null;
  owner_name: string | null;
  active: boolean;
  shares: number;
  matched: number;
  raised: string;
}

function QrSection() {
  const [rows, setRows] = useState<QrRow[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, cfg] = await Promise.all([
        api.get<{ qrs: QrRow[] }>("/api/crm/qrs?all=true"),
        api.get<{ users: { id: string; name: string }[] }>("/api/crm/config"),
      ]);
      setRows(q.qrs);
      setUsers(cfg.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the QR codes");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(id: string, body: Record<string, unknown>) {
    setError(null);
    try {
      await api.put(`/api/crm/qrs/${id}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
      await load();
    }
  }

  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5">
        <CardHeader
          title={`Razorpay QR codes${rows.length ? ` \u00b7 ${rows.length}` : ""}`}
          subtitle="Make them in the Razorpay dashboard, then paste each one's id here and say whose it is."
        />
        <button onClick={() => setAdding(true)} className={buttonPrimary}>
          Add a QR
        </button>
      </div>

      {error && <p className="px-5 pb-2 text-sm text-red-700">{error}</p>}
      {notice && <p className="px-5 pb-2 text-sm text-amber-800">{notice}</p>}

      <TableShell>
        <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
          <tr>
            <Th>Label</Th>
            <Th>Razorpay id</Th>
            <Th>Whose</Th>
            <Th align="right">Sent</Th>
            <Th align="right">Paid</Th>
            <Th align="right">Raised</Th>
            <Th align="center">In use</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {!rows.length ? (
            <tr>
              <td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">
                None yet. A caller sees no QR option until one is added here.
              </td>
            </tr>
          ) : (
            rows.map((q) => (
              <tr key={q.id} className={`hover:bg-slate-50/60 ${q.active ? "" : "opacity-60"}`}>
                <Td>
                  <input
                    defaultValue={q.label}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== q.label && void save(q.id, { label: e.target.value })}
                    className="w-full bg-transparent font-medium text-slate-900 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                  />
                  {q.purpose && <p className="text-[11px] text-slate-500">{q.purpose}</p>}
                </Td>
                <Td className="font-mono text-xs text-slate-500">{q.qr_id}</Td>
                <Td>
                  <Select
                    value={q.owner_id ?? ""}
                    onChange={(v) => void save(q.id, { owner_id: v || null })}
                    className="min-w-[10rem]"
                    options={[
                      { value: "", label: "The temple's (everyone)" },
                      ...users.map((u) => ({ value: u.id, label: u.name })),
                    ]}
                  />
                </Td>
                <Td align="right" className="tabular-nums text-slate-600">{number(q.shares)}</Td>
                <Td align="right" className="tabular-nums text-slate-700">
                  {q.matched ? number(q.matched) : <span className="text-slate-300">\u2014</span>}
                </Td>
                <Td align="right" className="tabular-nums font-medium text-slate-900">
                  {Number(q.raised) ? currency(Number(q.raised)) : <span className="text-slate-300">\u2014</span>}
                </Td>
                <Td align="center">
                  <Toggle on={q.active} onChange={(v) => void save(q.id, { active: v })} label={`${q.label} in use`} />
                </Td>
              </tr>
            ))
          )}
        </tbody>
      </TableShell>

      <div className="border-t border-[var(--line-soft)] px-5 py-4">
        <p className="text-xs text-slate-500">
          When a caller shares a QR, DRM records who it went to. Razorpay then reports the payment to
          <span className="font-mono"> /api/crm/qr/webhook</span>, and DRM matches it back to that lead by the QR,
          the timing and the amount. A payment it cannot place with confidence waits on the unmatched list rather
          than being credited to a guess.
        </p>
      </div>

      {adding && (
        <AddQrDialog
          users={users}
          onClose={() => setAdding(false)}
          onDone={async (warning) => {
            setAdding(false);
            setNotice(warning);
            await load();
          }}
        />
      )}
    </Card>
  );
}

function AddQrDialog({
  users,
  onClose,
  onDone,
}: {
  users: { id: string; name: string }[];
  onClose: () => void;
  onDone: (warning: string | null) => void;
}) {
  const [qrId, setQrId] = useState("");
  const [label, setLabel] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [purpose, setPurpose] = useState("");
  const [owner, setOwner] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title="Add a Razorpay QR" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <p className="mb-4 text-sm text-slate-600">
        In Razorpay, open the QR you want to use and copy its id and image link. DRM never creates or changes a QR
        \u2014 it only needs to recognise payments that come through one.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          What the caller will see <span className="text-red-600">*</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Annadan \u2014 Ravi"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Razorpay QR id <span className="text-red-600">*</span>
          <input
            value={qrId}
            onChange={(e) => setQrId(e.target.value.trim())}
            placeholder="qr_XXXXXXXXXXXX"
            className={`${inputClass} mt-1 w-full font-mono`}
          />
        </label>
        <label className="text-xs text-slate-500 sm:col-span-2">
          QR image link
          <input
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value.trim())}
            placeholder="https://\u2026"
            className={`${inputClass} mt-1 w-full`}
          />
          <span className="mt-0.5 block text-[11px] text-slate-400">
            This is what the donor receives on WhatsApp, so it has to be a link anyone can open.
          </span>
        </label>
        <label className="text-xs text-slate-500">
          What it is for
          <input
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Annadan Seva"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
        <label className="text-xs text-slate-500">
          Whose QR is it
          <Select
            value={owner}
            onChange={setOwner}
            className="mt-1 w-full"
            options={[
              { value: "", label: "The temple's (everyone)" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </label>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy || !qrId.trim() || !label.trim()}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.post<{ warning: string | null }>("/api/crm/qrs", {
                qr_id: qrId.trim(),
                label: label.trim(),
                image_url: imageUrl.trim() || undefined,
                purpose: purpose.trim() || undefined,
                owner_id: owner || undefined,
              });
              onDone(r.warning ?? null);
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not save that QR");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Saving\u2026" : "Add it"}
        </button>
      </div>
    </Modal>
  );
}
