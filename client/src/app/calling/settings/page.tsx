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

import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import {
  Alert,
  AlertPicker,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Icon,
  IconButton,
  Input,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  Skeleton,
  SkeletonRows,
  TableShell,
  Tabs,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
  Toggle,
} from "@/components/ui";
import { ALERT_OPTIONS, DEFAULT_ALERTS, cleanAlerts } from "@/lib/reminders";
import { apiClient as api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, number, relativeDate } from "@/lib/format";
import { toBase64 } from "@/lib/spreadsheet";

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
    help: "Higher means fewer pauses.",
    kind: "number",
  },
  retry_after_days: {
    label: "Days before calling a missed lead again",
    help: "Used when no follow-up date is set.",
    kind: "number",
  },
  max_attempts: {
    label: "Calls before stopping",
    help: "The lead is not deleted.",
    kind: "number",
  },
  stale_lead_days: {
    label: "Days before an old lead comes back",
    help: "For leads no one has called.",
    kind: "number",
  },
  callers_see_all_leads: {
    label: "Callers see all leads",
    help: "Off: only their leads and leads with no caller.",
    kind: "boolean",
  },
};

/**
 * The tabs, in the order somebody is likely to need them.
 *
 * Queue first because it is what changes most often; storage last because it
 * is set up once and then forgotten.
 */
const TABS = [
  { key: "queue", label: "Calling", icon: "list" },
  { key: "stages", label: "Stages & call results", icon: "target" },
  { key: "reminders", label: "Reminders", icon: "bell" },
  { key: "preachers", label: "Preachers", icon: "users" },
  { key: "qr", label: "QR codes", icon: "qr" },
  { key: "links", label: "Links", icon: "link" },
  { key: "storage", label: "Storage", icon: "box" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// useSearchParams needs a Suspense boundary, so the screen is split in two.
export default function CallingSettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-6xl">
          <Card>
            <Skeleton className="h-40 w-full" />
          </Card>
        </div>
      }
    >
      <CallingSettings />
    </Suspense>
  );
}

function CallingSettings() {
  const router = useRouter();
  const params = useSearchParams();
  // In the URL rather than in state, so a refresh keeps you where you were and
  // a link to "the preacher list" is a link somebody can actually send.
  const requested = params.get("tab");
  const tab: TabKey = (TABS.find((t) => t.key === requested)?.key ?? "queue") as TabKey;
  const setTab = (k: TabKey) => router.replace(`/calling/settings?tab=${k}`, { scroll: false });

  const [config, setConfig] = useState<Config | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newStage, setNewStage] = useState("");

  const load = useCallback(async () => {
    try {
      setConfig(await apiClient.get<Config>("/api/crm/config"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setSaving(null);
    }
  }

  return (
    // Wider than the old max-w-4xl: the QR and preacher tables carry seven or
    // eight columns and were being clipped at the right edge, which hid the
    // money. Tables inside still scroll on a narrow screen.
    <div className="max-w-6xl">
      <PageHeader
        eyebrow="Setup"
        title="Calling settings"
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {/* One screen at a time. This page had grown to eight stacked cards and
          about four thousand pixels: finding the preacher list meant scrolling
          past every queue setting, and nobody could send somebody a link to
          the part they meant. The tab lives in the URL for exactly that. */}
      <Tabs
        className="mb-5"
        items={TABS.map((t) => ({ key: t.key, label: t.label, icon: t.icon }))}
        value={tab}
        onChange={(k) => setTab(k as TabKey)}
      />

      <div className="space-y-6">
        {tab === "queue" && (
          <>
        <Card>
          <CardHeader icon="list" title="Calling" />
          <div className="space-y-4">
            {Object.entries(SETTING_COPY).map(([key, meta]) => {
              const value = config?.settings[key];
              return (
                <div key={key} className="flex flex-wrap items-start justify-between gap-4 border-b border-line-soft pb-4 last:border-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">{meta.label}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">{meta.help}</p>
                  </div>
                  {meta.kind === "boolean" ? (
                    // A switch, not a button labelled On/Off: a primary button
                    // means "this is the action to take", and using one to show
                    // a state made the setting look like something you press to
                    // do something rather than something that is already on.
                    <Toggle
                      on={!!value}
                      disabled={saving === key}
                      onChange={(v) => void saveSetting(key, v)}
                      label={meta.label}
                    />
                  ) : (
                    <div className="w-24">
                      <Input
                        type="number"
                        min={1}
                        aria-label={meta.label}
                        defaultValue={String(value ?? "")}
                        onBlur={(e) => Number(e.target.value) !== Number(value) && void saveSetting(key, Number(e.target.value))}
                        className="tabular-nums"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

          </>
        )}
        {tab === "stages" && (
          <>
        <div>
          {/* Header above the table rather than a Card wrapped around it:
              TableShell already draws a bordered, shadowed surface, and one
              inside a card showed two edges a pixel apart. */}
          <CardHeader
            icon="target"
            title="Stages"
            subtitle="Where a lead is."
          />
          <TableShell>
            <Thead>
              <Th>Stage</Th>
              <Th align="center">Gave</Th>
              <Th align="center">Lost</Th>
              <Th align="center">Keep calling</Th>
              <Th align="center">In use</Th>
            </Thead>
            {!config ? (
              <SkeletonRows rows={5} cols={5} />
            ) : (
              <Tbody>
                {config.statuses.map((s) => (
                  <tr key={s.slug}>
                    <Td>
                      <Input
                        defaultValue={s.label}
                        aria-label={`Stage name`}
                        onBlur={(e) => e.target.value !== s.label && void saveStatus(s.slug, { label: e.target.value })}
                      />
                      <span className="mt-1 block text-2xs text-ink-faint">{s.slug}</span>
                    </Td>
                    <Td align="center"><Toggle on={s.is_won} onChange={(v) => void saveStatus(s.slug, { is_won: v })} label={`${s.label}: gave`} /></Td>
                    <Td align="center"><Toggle on={s.is_lost} onChange={(v) => void saveStatus(s.slug, { is_lost: v })} label={`${s.label}: lost`} /></Td>
                    <Td align="center"><Toggle on={s.is_open} onChange={(v) => void saveStatus(s.slug, { is_open: v })} label={`${s.label}: keep calling`} /></Td>
                    <Td align="center"><Toggle on={s.active} onChange={(v) => void saveStatus(s.slug, { active: v })} label={`${s.label} in use`} /></Td>
                  </tr>
                ))}
              </Tbody>
            )}
            {/* The add row rides in the table's own footer so the section stays
                one surface — it used to sit under the table inside a second
                bordered card. */}
            <tfoot>
              <tr>
                <td colSpan={5} className="border-t border-line-soft bg-sunken px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        value={newStage}
                        aria-label="New stage"
                        onChange={(e) => setNewStage(e.target.value)}
                        placeholder="New stage, e.g. Will give after Kartik"
                      />
                    </div>
                    <Button
                      icon="plus"
                      disabled={!newStage.trim()}
                      onClick={() => {
                        const slug = newStage.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
                        void saveStatus(slug, { label: newStage.trim(), sort_order: 55, is_open: true, active: true });
                        setNewStage("");
                      }}
                    >
                      Add
                    </Button>
                  </div>
                </td>
              </tr>
            </tfoot>
          </TableShell>
        </div>

        {/* -------------------------------------------------- call outcomes */}
        <div>
          <CardHeader
            icon="phone"
            title="Call results"
            subtitle="What a caller taps after a call."
          />
          <TableShell>
            <Thead>
              <Th>Call result</Th>
              <Th align="center">Answered</Th>
              <Th>Moves lead to</Th>
              <Th align="center">Asks for follow-up</Th>
              <Th align="center">In use</Th>
            </Thead>
            {!config ? (
              <SkeletonRows rows={5} cols={5} />
            ) : (
              <Tbody>
                {config.dispositions.map((d) => (
                  <tr key={d.slug}>
                    <Td>
                      <Input
                        defaultValue={d.label}
                        aria-label={`Call result name`}
                        onBlur={(e) => e.target.value !== d.label && void saveDisposition(d.slug, { label: e.target.value })}
                      />
                    </Td>
                    <Td align="center">
                      <Toggle
                        on={d.counts_connected}
                        onChange={(v) => void saveDisposition(d.slug, { counts_connected: v })}
                        label={`${d.label}: answered`}
                      />
                    </Td>
                    <Td>
                      <Select
                        value={d.suggests_status ?? ""}
                        onChange={(v) => void saveDisposition(d.slug, { suggests_status: v || null })}
                        className="min-w-[9rem]"
                        ariaLabel={`Stage ${d.label} moves the lead to`}
                      >
                        <option value="">No change</option>
                        {config.statuses.map((s) => (
                          <option key={s.slug} value={s.slug}>{s.label}</option>
                        ))}
                      </Select>
                    </Td>
                    <Td align="center">
                      <Toggle
                        on={d.wants_follow_up}
                        onChange={(v) => void saveDisposition(d.slug, { wants_follow_up: v })}
                        label={`${d.label}: asks for follow-up`}
                      />
                    </Td>
                    <Td align="center">
                      <Toggle
                        on={d.active}
                        onChange={(v) => void saveDisposition(d.slug, { active: v })}
                        label={`${d.label} in use`}
                      />
                    </Td>
                  </tr>
                ))}
              </Tbody>
            )}
          </TableShell>
        </div>

          </>
        )}
        {tab === "reminders" && (
          <Card>
            <CardHeader
              icon="bell"
              title="Reminder alerts"
              subtitle="Default alerts before a promise is due."
            />

            <div className="mt-3">
              <AlertPicker
                value={
                  Array.isArray(config?.settings.reminder_lead_times)
                    ? (config.settings.reminder_lead_times as number[])
                    : DEFAULT_ALERTS
                }
                onChange={(next) => void saveSetting("reminder_lead_times", cleanAlerts(next))}
                options={ALERT_OPTIONS}
                emptyWarning="No alert will be sent."
              />
            </div>

            <div className="mt-5 flex flex-wrap items-start justify-between gap-4 border-t border-line-soft pt-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">Desktop notifications</p>
                <p className="mt-0.5 text-xs text-ink-muted">Alert even when DRM is in another tab.</p>
              </div>
              <Toggle
                on={!!config?.settings.reminder_desktop_alerts}
                disabled={saving === "reminder_desktop_alerts"}
                onChange={(v) => void saveSetting("reminder_desktop_alerts", v)}
                label="Desktop notifications"
              />
            </div>
          </Card>
        )}
        {tab === "preachers" && <PreachersSection />}
        {tab === "qr" && <QrSection />}
        {tab === "links" && <LinksSection />}
        {tab === "storage" && <StorageSection />}

        {tab === "queue" && (
          <>
        <Card>
          <CardHeader icon="info" title="Call recording" />
          <p className="text-sm text-ink-soft">Not available. Callers use their own phones.</p>
        </Card>
          </>
        )}
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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      await load();
    }
  }

  return (
    <div>
      <CardHeader
        icon="users"
        title={`Preachers${rows.length ? ` · ${rows.length}` : ""}`}
        subtitle="Add names to the codes from your sheets."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={q}
              onChange={setQ}
              placeholder="Name, code or ID"
              className="w-52"
            />
            <Button icon="userPlus" onClick={() => setAdding(true)}>
              Add a preacher
            </Button>
          </div>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <TableShell>
        <Thead>
          <Th>Code</Th>
          <Th>Name</Th>
          <Th>ID No.</Th>
          <Th align="right">Leads</Th>
          <Th align="right">To call</Th>
          <Th align="right">Temple records</Th>
          <Th align="right">Money raised</Th>
          <Th align="center">In use</Th>
        </Thead>
        {!rows.length ? (
          <tbody>
            <tr>
              <td colSpan={8}>
                <EmptyState
                  icon="users"
                  title={q.trim() ? "No match" : "No preachers yet"}
                  message={
                    q.trim()
                      ? `Nothing matches “${q.trim()}”.`
                      : "Add one, or upload a sheet."
                  }
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium tabular-nums text-ink">{p.code}</Td>
                <Td>
                  <Input
                    defaultValue={p.name ?? ""}
                    placeholder="Name"
                    aria-label={`Name for ${p.code}`}
                    onBlur={(e) => e.target.value !== (p.name ?? "") && void save(p.id, { name: e.target.value })}
                  />
                </Td>
                <Td>
                  {/* Typed in, never generated. A number DRM invented would
                      look identical on screen to one the office issued, and
                      afterwards nobody could tell which was which. */}
                  <div className="w-28">
                    <Input
                      defaultValue={p.id_number ?? ""}
                      placeholder="—"
                      aria-label={`ID No. for ${p.code}`}
                      className="tabular-nums"
                      onBlur={(e) =>
                        e.target.value.trim().toUpperCase() !== (p.id_number ?? "") &&
                        void save(p.id, { id_number: e.target.value })
                      }
                    />
                  </div>
                </Td>
                <Td align="right" className="tabular-nums">{number(p.leads)}</Td>
                <Td align="right" className="tabular-nums">{number(p.open_leads)}</Td>
                <Td align="right" className="tabular-nums">
                  {Number(p.external_total) ? currency(Number(p.external_total)) : <span className="text-ink-faint">—</span>}
                </Td>
                <Td align="right" className="font-medium tabular-nums text-ink">
                  {Number(p.raised) ? currency(Number(p.raised)) : <span className="text-ink-faint">—</span>}
                </Td>
                <Td align="center">
                  <Toggle on={p.active} onChange={(v) => void save(p.id, { active: v })} label={`${p.code} in use`} />
                </Td>
              </tr>
            ))}
          </Tbody>
        )}
      </TableShell>



      {adding && (
        <AddPreacherDialog
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await load();
          }}
        />
      )}
    </div>
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
    <Modal
      title="Add a preacher"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!code.trim()}
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
                setError(e instanceof Error ? e.message : "Could not save. Try again.");
                setBusy(false);
              }
            }}
          >
            Add
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="preacher-name">
          <Input
            id="preacher-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jagat Tarini Mataji"
          />
        </Field>
        <Field label="Code" htmlFor="preacher-code" required hint="Same as Enrolled By in your sheets">
          <Input
            id="preacher-code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/\s+/g, ""))}
            placeholder="e.g. JTMD"
            className="tabular-nums"
          />
        </Field>
        <Field label="ID No." htmlFor="preacher-id">
          <Input
            id="preacher-id"
            value={idNumber}
            onChange={(e) => setIdNumber(e.target.value)}
            placeholder="e.g. 1042 or HKM-118"
            className="tabular-nums"
          />
        </Field>
        <Field label="Mobile Number (optional)" htmlFor="preacher-phone">
          <Input
            id="preacher-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            className="tabular-nums"
          />
        </Field>
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
 *
 * TWO DIFFERENT PEOPLE CAN BE ATTACHED TO ONE LINK, and they do unrelated jobs:
 *
 *   owner_user_id decides whose picker the link shows up in. Nothing else.
 *   credit_user_id decides who is credited for the money it raises.
 *
 * A link can sit in the shared list for the whole team to send and still credit
 * one caller, which is the usual arrangement for a campaign somebody is
 * working. The table keeps the two in separate columns, worded as what they
 * actually do, because treating them as one thing is how a caller ends up being
 * paid attention for a link they cannot see, or seeing one that pays them
 * nothing.
 */
interface LinkRow {
  id: string;
  label: string;
  url: string;
  seva_name: string | null;
  message: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  /** Who the donations through this link are credited to, if anybody. */
  credit_user_id: string | null;
  credit_user_name: string | null;
  /** What rides home on the URL as utm_campaign, and matches the money back. */
  credit_token: string | null;
  sort_order: number;
  active: boolean;
  use_count: number;
}

function LinksSection() {
  const { user } = useAuth();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  // PUT /links/:id/credit is authorize('admin'), so a caller is shown who each
  // link credits and no control to change it - an assignment dropdown that
  // answered 403 on every use would be worse than not offering one.
  const isAdmin = user?.role === "admin";

  const load = useCallback(async () => {
    try {
      const [d, cfg] = await Promise.all([
        api.get<{ links: LinkRow[] }>("/api/crm/links/all"),
        // The same team list the QR table assigns from, for the same reason.
        api.get<{ users: { id: string; name: string }[] }>("/api/crm/config"),
      ]);
      setLinks(d.links);
      setUsers(cfg.users);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    }
  }

  /**
   * Say whose money this link raises.
   *
   * Its own endpoint rather than a field on PUT /links, because the server
   * guards the two differently: anyone may edit a shared link's wording, and
   * only an admin may decide who gets credited for what it brings in.
   */
  async function saveCredit(id: string, userId: string | null) {
    setError(null);
    try {
      // null, not an omitted field: the server refuses a body without user_id
      // precisely so that "unassign" cannot be confused with "forgot to say".
      await api.put(`/api/crm/links/${id}/credit`, { user_id: userId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      await load();
    }
  }

  async function remove(id: string, label: string) {
    if (!confirm(`Delete "${label}"?`)) return;
    try {
      await api.delete(`/api/crm/links/${id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete. Try again.");
    }
  }

  return (
    <div>
      <CardHeader
        icon="link"
        title="Links"
        subtitle="Callers send these on WhatsApp. Changes apply to everyone."
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <TableShell>
        <Thead>
          <Th className="w-1/4">Name</Th>
          <Th>Link</Th>
          {/* Two columns, two unrelated questions, each headed with what it
              actually decides. The second one used to read just "Shared",
              which beside a column about crediting is the same question asked
              twice - and the whole point is that they are not the same. */}
          <Th>Counts for</Th>
          <Th align="right">Sent</Th>
          <Th align="center">Shown to</Th>
          <Th align="center">In use</Th>
          <Th align="right"><span className="sr-only">Actions</span></Th>
        </Thead>
        {!links.length ? (
          <tbody>
            <tr>
              <td colSpan={7}>
                <EmptyState
                  icon="link"
                  title="No links yet"
                  message="Links you add show for all callers."
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {links.map((l) => (
              // A fragment, because a link in edit mode renders two <tr>s and
              // they cannot be wrapped in a <div> inside a <tbody>. The key
              // belongs on the fragment, not on the rows inside it.
              <Fragment key={l.id}>
                <tr>
                  <Td>
                    <Input
                      defaultValue={l.label}
                      aria-label={`Link name`}
                      onBlur={(e) => e.target.value !== l.label && void save(l.id, { label: e.target.value })}
                    />
                    {l.seva_name && <span className="mt-1 block text-2xs text-ink-faint">{l.seva_name}</span>}
                  </Td>
                  <Td className="max-w-[16rem]">
                    <span className="block truncate text-xs text-ink-muted" title={l.url}>
                      {l.url}
                    </span>
                  </Td>
                  <Td>
                    {isAdmin ? (
                      <Select
                        value={l.credit_user_id ?? ""}
                        onChange={(v) => void saveCredit(l.id, v || null)}
                        className="min-w-[10rem]"
                        ariaLabel={`${l.label} counts for`}
                        options={[
                          { value: "", label: "No one" },
                          ...users.map((u) => ({ value: u.id, label: u.name })),
                        ]}
                      />
                    ) : l.credit_user_name ? (
                      <Badge tone="good" icon="rupee">
                        {l.credit_user_name}
                      </Badge>
                    ) : (
                      <span className="text-xs text-ink-faint">No one</span>
                    )}
                    {/* The token is a diagnostic, not something anybody types:
                        it is here so that "why was this donation not credited"
                        can be answered by comparing it with the utm_campaign on
                        the donation, and for nothing else. */}
                    {l.credit_user_id && l.credit_token && (
                      <span
                        className="mt-1 block truncate font-mono text-2xs text-ink-faint"
                        title="Tracking code on the link"
                      >
                        {l.credit_token}
                      </span>
                    )}
                  </Td>
                  <Td align="right" className="text-sm tabular-nums">
                    {l.use_count || <span className="text-ink-faint">0</span>}
                  </Td>
                  <Td align="center">
                    {l.owner_user_id ? (
                      <Badge tone="neutral">{l.owner_name ?? "Private"}</Badge>
                    ) : (
                      <Badge tone="good">Everyone</Badge>
                    )}
                  </Td>
                  <Td align="center">
                    <Toggle on={l.active} onChange={(v) => void save(l.id, { active: v })} label={`${l.label} in use`} />
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    <div className="flex justify-end gap-1.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={editing === l.id ? "chevronUp" : "edit"}
                        onClick={() => setEditing(editing === l.id ? null : l.id)}
                      >
                        {editing === l.id ? "Close" : "Edit"}
                      </Button>
                      <Button
                        size="sm"
                        variant="dangerSoft"
                        icon="trash"
                        onClick={() => void remove(l.id, l.label)}
                      >
                        Delete
                      </Button>
                    </div>
                  </Td>
                </tr>
                {editing === l.id && (
                  <tr>
                    <td colSpan={7} className="bg-sunken px-4 py-3">
                      <Field label="Link" className="mb-2">
                        <Input
                          defaultValue={l.url}
                          aria-label={`Link`}
                          onBlur={(e) => e.target.value !== l.url && void save(l.id, { url: e.target.value })}
                        />
                      </Field>
                      <Field
                        label="Message"
                        hint={`${"{name}"} ${"{seva}"} ${"{link}"} ${"{amount}"} are filled in`}
                      >
                        <Textarea
                          defaultValue={l.message ?? ""}
                          aria-label={`Message`}
                          onBlur={(e) => e.target.value !== (l.message ?? "") && void save(l.id, { message: e.target.value })}
                          rows={4}
                          className="resize-y"
                        />
                      </Field>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </Tbody>
        )}
      </TableShell>

      {!isAdmin && (
        <p className="mt-3 text-xs text-ink-faint">Only an admin can change who a link counts for.</p>
      )}
    </div>
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
  receipt_site: string | null;
  image_key: string | null;
  active: boolean;
  shares: number;
  matched: number;
  /** Every captured payment through this QR — attributed or not. */
  raised: string;
  attributed: string;
  payments: number;
  unattributed: number;
  last_payment_at: string | null;
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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      await load();
    }
  }

  return (
    <div>
      <CardHeader
        icon="qr"
        title={`Razorpay QR codes${rows.length ? ` · ${rows.length}` : ""}`}
        subtitle="Make the QR in Razorpay, then add its ID here."
        action={
          <Button icon="plus" onClick={() => setAdding(true)}>
            Add a QR
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && (
        <Alert tone="warn" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}

      <TableShell>
        <Thead>
          <Th>Name</Th>
          <Th>Razorpay ID</Th>
          <Th>Caller</Th>
          <Th>Receipt from</Th>
          <Th align="right">Sent</Th>
          <Th align="right">Paid</Th>
          <Th align="right">Raised</Th>
          <Th align="right">Last paid</Th>
          <Th align="center">In use</Th>
          <Th align="right">Image</Th>
        </Thead>
        {!rows.length ? (
          <tbody>
            <tr>
              <td colSpan={10}>
                <EmptyState
                  icon="qr"
                  title="No QR codes yet"
                  message="Add a QR so callers can send it."
                  action={
                    <Button icon="plus" onClick={() => setAdding(true)}>
                      Add a QR
                    </Button>
                  }
                />
              </td>
            </tr>
          </tbody>
        ) : (
          <Tbody>
            {rows.map((q) => (
              <tr key={q.id} className={q.active ? "" : "opacity-60"}>
                {/* The label is what a caller picks from mid-call, so it has
                    to be readable here — the column was being squeezed to
                    "Annac" by the dropdowns beside it. */}
                <Td className="min-w-[11rem]">
                  <Input
                    defaultValue={q.label}
                    aria-label={`Name for ${q.qr_id}`}
                    onBlur={(e) => e.target.value.trim() && e.target.value !== q.label && void save(q.id, { label: e.target.value })}
                  />
                  {q.purpose && <p className="mt-1 text-2xs text-ink-muted">{q.purpose}</p>}
                </Td>
                <Td className="font-mono text-xs text-ink-muted">{q.qr_id}</Td>
                <Td>
                  <Select
                    value={q.owner_id ?? ""}
                    onChange={(v) => void save(q.id, { owner_id: v || null })}
                    className="min-w-[10rem]"
                    ariaLabel={`Caller for ${q.label}`}
                    options={[
                      { value: "", label: "Temple (everyone)" },
                      ...users.map((u) => ({ value: u.id, label: u.name })),
                    ]}
                  />
                </Td>
                <Td>
                  {/* Which 80G series the receipt comes from. Without this DRM
                      records the donation and issues nothing, which is how a
                      donor ends up paying and getting no receipt. */}
                  <Select
                    value={q.receipt_site ?? ""}
                    onChange={(v) => void save(q.id, { receipt_site: v || null })}
                    className="min-w-[9rem]"
                    ariaLabel={`Receipt site for ${q.label}`}
                    options={[
                      { value: "", label: "No receipt" },
                      { value: "hkmv", label: "harekrishnavizag.org" },
                      { value: "annadan", label: "annadan" },
                    ]}
                  />
                  {!q.receipt_site && (
                    <p className="mt-0.5 text-2xs text-warn">Donors get no receipt</p>
                  )}
                </Td>
                <Td align="right" className="tabular-nums">{number(q.shares)}</Td>
                <Td align="right" className="tabular-nums">
                  {q.matched ? number(q.matched) : <span className="text-ink-faint">—</span>}
                </Td>
                {/* Every rupee through this QR, not only the part DRM has
                    managed to tie to a donor. These QRs are shared on calls and
                    nowhere else, so all of it was raised by calling - and
                    counting only the attributed part understated each QR by
                    exactly the payments still needing attention. */}
                <Td align="right" className="font-medium tabular-nums text-ink">
                  {Number(q.raised) ? currency(Number(q.raised)) : <span className="text-ink-faint">—</span>}
                  {q.unattributed > 0 && (
                    <p className="text-2xs font-normal text-warn">
                      {number(q.unattributed)} not linked yet
                    </p>
                  )}
                </Td>
                <Td align="right" className="text-2xs text-ink-muted">
                  {q.last_payment_at ? relativeDate(q.last_payment_at) : <span className="text-ink-faint">—</span>}
                </Td>
                <Td align="center">
                  <Toggle on={q.active} onChange={(v) => void save(q.id, { active: v })} label={`${q.label} in use`} />
                </Td>
                <Td align="right">
                  <QrImageButton qr={q} onDone={load} onError={setError} />
                </Td>
              </tr>
            ))}
          </Tbody>
        )}
      </TableShell>

      <div className="mt-3">
        {/* Named explicitly because it is the one setting that silently stops
            all of this working: a Razorpay payment object does not say which QR
            it was paid into, and qr_code.credited is the only delivery that
            does. Subscribed to payment.captured alone, every QR donation
            arrives attached to nothing. */}
        <p className="text-xs text-ink-muted">
          In Razorpay, turn on <span className="font-mono">qr_code.credited</span> for{" "}
          <span className="font-mono">/api/razorpay/webhook</span>.
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
    </div>
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
  const [site, setSite] = useState("hkmv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picture, as a file. Held until the QR row exists, because the upload
  // endpoint stores it against a QR id - so this dialog does the two steps in
  // order rather than making the admin come back and do the second one.
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The object URL is revoked when it is replaced or the dialog closes;
  // without this every re-pick leaks a blob for the life of the tab.
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  return (
    <Modal
      title="Add a Razorpay QR"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!qrId.trim() || !label.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api.post<{ warning: string | null; qr: { id: string } }>("/api/crm/qrs", {
                  qr_id: qrId.trim(),
                  label: label.trim(),
                  image_url: imageUrl.trim() || undefined,
                  purpose: purpose.trim() || undefined,
                  owner_id: owner || undefined,
                  receipt_site: site || undefined,
                });

                // The picture, second, against the row that now exists. A failure
                // here is reported as its own thing rather than rolled back: the
                // QR is saved and usable, and losing the id and the label because
                // an image would not upload would be the worse outcome.
                let warning = r.warning ?? null;
                if (file) {
                  try {
                    await api.post(`/api/crm/qrs/${r.qr.id}/image`, {
                      filename: file.name,
                      base64: toBase64(await file.arrayBuffer()),
                    });
                  } catch (e) {
                    warning = `${label.trim()} saved. Picture did not upload: ${
                      e instanceof Error ? e.message : "unknown error"
                    } Tap Upload to try again.`;
                  }
                }
                onDone(warning);
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not save. Try again.");
                setBusy(false);
              }
            }}
          >
            Add
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}



      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" htmlFor="qr-label" required>
          <Input
            id="qr-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Annadan Ravi"
          />
        </Field>
        <Field label="Razorpay QR ID" htmlFor="qr-id" required hint="Copy it from Razorpay">
          <Input
            id="qr-id"
            value={qrId}
            onChange={(e) => setQrId(e.target.value.trim())}
            placeholder="qr_XXXXXXXXXXXX"
            className="font-mono"
          />
        </Field>
        {/* The picture. A file first, because that is what the temple
            actually has - the designed QR with the seva name and the deity on
            it, sitting in someone's Downloads folder. Pasting a link is still
            there underneath for the case where the image already lives
            somewhere public. */}
        <div className="sm:col-span-2">
          <p className="mb-1 block text-xs font-medium text-ink-soft">QR picture</p>
          <div className="flex items-center gap-3">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={preview}
                alt=""
                className="h-16 w-16 rounded-control border border-line-soft bg-surface object-contain"
              />
            ) : (
              <div className="grid h-16 w-16 place-items-center rounded-control border border-dashed border-line-strong text-ink-faint">
                <Icon name="qr" size={24} />
              </div>
            )}
            <div className="min-w-0">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > 2 * 1024 * 1024) {
                    setError("Image is over 2 MB. Pick a smaller one.");
                    return;
                  }
                  setError(null);
                  setFile(f);
                }}
              />
              <Button variant="secondary" icon="upload" onClick={() => fileRef.current?.click()}>
                {file ? "Change picture" : "Pick a picture"}
              </Button>
              <p className="mt-1 truncate text-2xs text-ink-faint">
                {file ? file.name : "PNG or JPG, under 2 MB"}
              </p>
            </div>
          </div>

          {!file && (
            <Field label="Or paste an image link" htmlFor="qr-image-url" className="mt-2">
              <Input
                id="qr-image-url"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value.trim())}
                placeholder="https://…"
              />
            </Field>
          )}
        </div>
        <Field label="Seva" htmlFor="qr-purpose">
          <Input
            id="qr-purpose"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Annadan Seva"
          />
        </Field>
        <Field label="Caller">
          <Select
            value={owner}
            onChange={setOwner}
            ariaLabel="Caller"
            options={[
              { value: "", label: "Temple (everyone)" },
              ...users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </Field>
        <Field label="80G receipt from" className="sm:col-span-2">
          <Select
            value={site}
            onChange={setSite}
            ariaLabel="80G receipt from"
            options={[
              { value: "hkmv", label: "harekrishnavizag.org" },
              { value: "annadan", label: "annadan" },
              { value: "", label: "No receipt" },
            ]}
          />
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Uploading the branded QR image a donor actually receives.
 *
 * Razorpay hosts a plain square. The temple designs its own with the seva name
 * and the deity on it, and this puts that image somewhere a donor's phone can
 * fetch it straight from WhatsApp.
 *
 * It needs a public bucket and says so plainly when there isn't one, rather
 * than storing something no donor could load.
 */
function QrImageButton({
  qr,
  onDone,
  onError,
}: {
  qr: QrRow;
  onDone: () => Promise<void> | void;
  onError: (m: string) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      return onError("Image is over 2 MB. Pick a smaller one.");
    }
    setBusy(true);
    try {
      await api.post(`/api/crm/qrs/${qr.id}/image`, {
        filename: file.name,
        base64: toBase64(await file.arrayBuffer()),
      });
      await onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not upload. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-end gap-1">
      <input
        ref={ref}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
      />
      <Button
        size="sm"
        variant="secondary"
        icon="upload"
        loading={busy}
        onClick={() => ref.current?.click()}
      >
        {qr.image_key ? "Replace" : "Upload"}
      </Button>
      {qr.image_key && (
        <IconButton
          name="trash"
          size="sm"
          variant="dangerSoft"
          label={`Remove picture`}
          onClick={async () => {
            try {
              await api.delete(`/api/crm/qrs/${qr.id}/image`);
              await onDone();
            } catch (e) {
              onError(e instanceof Error ? e.message : "Could not remove. Try again.");
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * What file storage is keeping, and what it is not.
 *
 * Shown whether or not a bucket is set up, because the useful thing to know
 * when it is missing is exactly which of these is not happening — not a blank
 * space where a feature would be.
 */
interface StorageStatus {
  configured: boolean;
  public_urls: boolean;
  sheets_kept: number;
  sheets_total: number;
  receipts_cached: number;
  receipt_bytes: string;
  qr_images: number;
}

function StorageSection() {
  const [s, setS] = useState<StorageStatus | null>(null);

  useEffect(() => {
    api
      .get<StorageStatus>("/api/crm/storage/status")
      .then(setS)
      .catch(() => undefined);
  }, []);

  if (!s) return null;

  const mb = (bytes: string) => {
    const n = Number(bytes);
    return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
  };

  return (
    <Card>
      <CardHeader
        icon="box"
        title="File storage"
        subtitle={
          s.configured
            ? "Uploaded files, QR pictures and receipts."
            : "Not set up. Everything else still works."
        }
      />

      {s.configured ? (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">
                {number(s.sheets_kept)}
                <span className="text-base font-normal text-ink-faint"> / {number(s.sheets_total)}</span>
              </p>
              <p className="text-xs text-ink-soft">Sheets saved</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{number(s.receipts_cached)}</p>
              <p className="text-xs text-ink-soft">Receipts saved · {mb(s.receipt_bytes)}</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums text-ink">{number(s.qr_images)}</p>
              <p className="text-xs text-ink-soft">QR pictures</p>
            </div>
          </div>

          {!s.public_urls && (
            <Alert tone="warn" className="mt-3">
              QR pictures cannot be uploaded. Set <span className="font-mono">R2_PUBLIC_BASE_URL</span> to turn it on.
            </Alert>
          )}


        </>
      ) : (
        <div className="text-sm text-ink-soft">
          <p>Uploaded files, QR pictures and receipts are not saved.</p>
          <p className="mt-2 text-xs text-ink-muted">
            To turn it on, set <span className="font-mono">R2_ACCOUNT_ID</span>,{" "}
            <span className="font-mono">R2_ACCESS_KEY_ID</span>,{" "}
            <span className="font-mono">R2_SECRET_ACCESS_KEY</span> and{" "}
            <span className="font-mono">R2_BUCKET</span>, plus{" "}
            <span className="font-mono">R2_PUBLIC_BASE_URL</span> for the QR images.
          </p>
        </div>
      )}
    </Card>
  );
}
