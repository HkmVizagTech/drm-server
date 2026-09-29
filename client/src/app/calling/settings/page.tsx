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
import { Badge, buttonPrimary, buttonSecondary, Card, CardHeader, inputClass, PageHeader, Select, TableShell, Td, Th } from "@/components/ui";
import { apiClient as api } from "@/lib/api";

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

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? "bg-[var(--accent)]" : "bg-slate-200"}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? "translate-x-4.5" : "translate-x-1"}`} />
    </button>
  );
}
