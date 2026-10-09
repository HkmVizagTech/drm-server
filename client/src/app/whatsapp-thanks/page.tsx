"use client";

// WhatsApp thanks after a campaign donation - first for Mahalaya Amavasya.
//
// Everybody who donates on the campaign page that day gets the approved
// template about two hours later, sent by DRM through Gupshup (the site does
// no extra work). This screen switches it on and off, holds the template id,
// image and wording, sends a test, and shows who is waiting, sent or failed.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, currency, number } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Skeleton,
  StatTile,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toggle,
} from "@/components/ui";
import { toast } from "@/components/toast";

interface Settings {
  enabled: boolean;
  page: string;
  day: string;
  delay_minutes: number;
  last_send: string;
  stop_at: string;
  template_id: string;
  header_image: string;
  sevas: SevaChoice[];
}

interface SevaChoice {
  name: string;
  text: string;
  on: boolean;
}

interface Row {
  id: string;
  phone: string;
  name: string | null;
  amount: string | null;
  donated_at: string | null;
  seva: string | null;
  seva_text: string | null;
  send_at: string | null;
  status: "waiting" | "sending" | "sent" | "failed" | "skipped";
  error: string | null;
  sent_at: string | null;
}

interface Answer {
  settings: Settings;
  gupshup_ready: boolean;
  counts: { waiting: number; sending: number; sent: number; failed: number; skipped: number; next_at: string | null };
  today: { donations: number; people: number; amount: number };
  by_seva: { seva: string; people: number }[];
  rows: Row[];
}

const STATUS: Record<Row["status"], { label: string; tone: "neutral" | "good" | "warn" | "info" | "danger" }> = {
  waiting: { label: "Waiting", tone: "info" },
  sending: { label: "Sending", tone: "info" },
  sent: { label: "Sent", tone: "good" },
  failed: { label: "Failed", tone: "danger" },
  skipped: { label: "Not sent", tone: "neutral" },
};

const MESSAGE = (name: string, seva: string) => `Hare Krishna ${name} 🙏

On this sacred occasion of Mahalaya Amavasya, special prayers were offered today, seeking the blessings for the peace and spiritual well-being of your departed ancestors.

We are grateful for your offering towards ${seva} on this auspicious occasion.

May Lord Krishna bless you and your family with peace, devotion, and spiritual well-being.

Hare Krishna 🙏`;

export default function WhatsAppThanksPage() {
  const { user } = useAuth();
  const [data, setData] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testing, setTesting] = useState(false);
  /** Which seva the preview and the test show. */
  const [pick, setPick] = useState(0);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    apiClient
      .get<Answer>("/api/wa-thanks")
      .then((d) => {
        if (!live) return;
        setData(d);
        setForm((f) => f ?? d.settings);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    return () => {
      live = false;
    };
  }, [reload]);

  // The list moves on its own while it is switched on.
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden) setReload((n) => n + 1);
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const save = useCallback(
    async (patch: Partial<Settings>, okText: string) => {
      setSaving(true);
      try {
        const r = await apiClient.put<{ settings: Settings }>("/api/wa-thanks", patch);
        setForm(r.settings);
        toast(okText);
        setReload((n) => n + 1);
      } catch (e) {
        toast.error("Not saved", e instanceof Error ? e.message : undefined);
      } finally {
        setSaving(false);
      }
    },
    []
  );

  if (user && user.role !== "admin") {
    return (
      <div>
        <PageHeader eyebrow="Setup" title="WhatsApp thanks" />
        <Card>
          <EmptyState icon="shield" title="Administrators only" message="Ask an admin for access." />
        </Card>
      </div>
    );
  }

  const s = data?.settings;
  const set = (patch: Partial<Settings>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const changed =
    !!form &&
    !!s &&
    (Object.keys(form) as (keyof Settings)[]).some((k) => k !== "enabled" && JSON.stringify(form[k]) !== JSON.stringify(s[k]));
  const setSeva = (i: number, patch: Partial<SevaChoice>) =>
    setForm((f) => (f ? { ...f, sevas: f.sevas.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : f));
  const shown = form?.sevas[pick] ?? form?.sevas[0];
  // Sevas donated to today that are not on the list - a name changed on the site.
  const listed = new Set((s?.sevas ?? []).map((x) => x.name.toLowerCase()));
  const unlisted = (data?.by_seva ?? []).filter((b) => !listed.has(b.seva.toLowerCase()));

  return (
    <div>
      <PageHeader
        eyebrow="Setup"
        title="WhatsApp thanks"
        subtitle="A WhatsApp message to everyone who donates on the campaign page, about two hours after they donate. Sent by DRM through Gupshup."
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {data && !data.gupshup_ready && (
        <Alert tone="warn" title="Gupshup is not set up on the DRM server">
          Add GUPSHUP_API_KEY, GUPSHUP_APP_NAME and GUPSHUP_SOURCE_NUMBER to DRM&apos;s server settings - the same values the
          main site&apos;s server uses - and restart DRM. Until then nothing can be sent.
        </Alert>
      )}

      {!data || !form || !s ? (
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* On / off - the one control that matters on the day. */}
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-base font-semibold text-ink">
                  {s.enabled ? <Badge tone="good" dot>On</Badge> : <Badge tone="neutral" dot>Off</Badge>}
                  Thank donors on {s.page} on {new Date(`${s.day}T12:00:00+05:30`).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}
                </p>
                <p className="mt-1 text-sm text-ink-muted">
                  {s.delay_minutes} minutes after they donate. Nothing after {s.stop_at}; anyone due later than {s.last_send} gets it at {s.last_send}.
                </p>
              </div>
              <Toggle
                on={s.enabled}
                disabled={saving || (!s.enabled && !s.template_id)}
                onChange={(on) => void save({ enabled: on }, on ? "Switched on" : "Switched off")}
                label="Send the thank-you messages"
              />
            </div>
            {!s.template_id && (
              <p className="mt-3 text-xs text-warn">Add the Gupshup template id below to switch it on.</p>
            )}
          </Card>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Donated on the page" value={number(data.today.people)} sub={data.today.amount ? currency(data.today.amount) : undefined} />
            <StatTile label="Waiting" value={number(data.counts.waiting + data.counts.sending)} sub={data.counts.next_at ? `next at ${clockTime(data.counts.next_at)}` : undefined} accent="brand" />
            <StatTile label="Sent" value={number(data.counts.sent)} accent="good" />
            <StatTile label="Failed" value={number(data.counts.failed)} accent={data.counts.failed ? "danger" : "default"} />
            <StatTile label="Not sent" value={number(data.counts.skipped)} sub="reason in the list below" />
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <Card>
              <CardHeader title="Message" icon="message" subtitle="The template must be approved in Gupshup with an image header, {{1}} and {{2}}." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Gupshup template id" htmlFor="wt-template" className="sm:col-span-2">
                  <Input
                    id="wt-template"
                    value={form.template_id}
                    onChange={(e) => set({ template_id: e.target.value.trim() })}
                    placeholder="e.g. f12a709c-bc1f-429b-84d5-1262bc01a73c"
                    className="font-mono text-xs"
                  />
                </Field>
                <Field label="Header image (JPG or PNG link)" htmlFor="wt-image" className="sm:col-span-2">
                  <Input
                    id="wt-image"
                    value={form.header_image}
                    onChange={(e) => set({ header_image: e.target.value.trim() })}
                    placeholder="https://…/amavasya.jpg"
                  />
                </Field>
                <Field label="Campaign page" htmlFor="wt-page">
                  <Input id="wt-page" value={form.page} onChange={(e) => set({ page: e.target.value })} />
                </Field>
                <Field label="Campaign day" htmlFor="wt-day">
                  <Input id="wt-day" type="date" value={form.day} onChange={(e) => set({ day: e.target.value })} />
                </Field>
                <Field label="Minutes after the donation" htmlFor="wt-delay">
                  <Input
                    id="wt-delay"
                    inputMode="numeric"
                    value={String(form.delay_minutes)}
                    onChange={(e) => set({ delay_minutes: Number(e.target.value.replace(/\D/g, "")) || 0 })}
                    className="tabular-nums"
                  />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Last send" htmlFor="wt-last">
                    <Input id="wt-last" type="time" value={form.last_send} onChange={(e) => set({ last_send: e.target.value })} />
                  </Field>
                  <Field label="Stop at" htmlFor="wt-stop">
                    <Input id="wt-stop" type="time" value={form.stop_at} onChange={(e) => set({ stop_at: e.target.value })} />
                  </Field>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button
                  loading={saving}
                  disabled={!changed}
                  onClick={() => {
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    const { enabled, ...rest } = form;
                    void save(rest, "Saved");
                  }}
                >
                  Save
                </Button>
                {changed && (
                  <Button variant="ghost" onClick={() => setForm(s)}>
                    Undo changes
                  </Button>
                )}
              </div>
            </Card>

            <div className="space-y-5">
              <Card>
                <CardHeader title="What they receive" icon="eye" />
                {form.sevas.length > 1 && (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {form.sevas.map((x, i) => (
                      <button
                        key={x.name + i}
                        type="button"
                        onClick={() => setPick(i)}
                        className={`rounded-pill px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${
                          shown === x ? "bg-brand-700 text-white ring-brand-700" : "bg-surface text-ink-soft ring-line-strong hover:bg-sunken"
                        }`}
                      >
                        {x.name}
                      </button>
                    ))}
                  </div>
                )}
                {shown && !shown.on ? (
                  <p className="rounded-card bg-sunken p-3 text-sm text-ink-muted">{shown.name} donors get no message - it is switched off.</p>
                ) : (
                  <div className="whitespace-pre-line rounded-card bg-[#e7f7e4] p-3 text-sm leading-relaxed text-ink">
                    {MESSAGE("chaitanya", shown?.text || "…")}
                  </div>
                )}
              </Card>
              <Card>
                <CardHeader title="Send a test" icon="phone" subtitle="The real message, to one number, now." />
                <div className="flex gap-2">
                  <Input
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value.replace(/[^\d\s+]/g, ""))}
                    placeholder="Your mobile number"
                    inputMode="tel"
                    aria-label="Mobile number for the test"
                    className="tabular-nums"
                  />
                  <Button
                    loading={testing}
                    disabled={!s.template_id || changed}
                    onClick={async () => {
                      setTesting(true);
                      try {
                        await apiClient.post("/api/wa-thanks/test", { phone: testPhone, name: user?.name ?? "Devotee", seva: shown?.name });
                        toast(`Test sent (${shown?.name ?? "seva"}) - check WhatsApp`);
                      } catch (e) {
                        toast.error("Test not sent", e instanceof Error ? e.message : undefined);
                      } finally {
                        setTesting(false);
                      }
                    }}
                  >
                    Send
                  </Button>
                </div>
                <p className="mt-2 text-xs text-ink-muted">
                  {changed ? "Save your changes first." : `Sent with the ${shown?.name ?? ""} wording - pick another seva above to test it.`}
                </p>
              </Card>
            </div>
          </div>

          <Card>
            <CardHeader
              title="Sevas on the page"
              icon="list"
              subtitle="Each donor is thanked for the seva they chose. Switch a seva off and its donors get no message."
            />
            {unlisted.length > 0 && (
              <Alert tone="warn" title="Donations today to a seva not on this list">
                {unlisted.map((u) => `${u.seva} (${u.people})`).join(", ")} - these donors will not get a message. Add the seva below,
                spelt exactly as shown, if they should.
              </Alert>
            )}
            <ul className="divide-y divide-line-soft">
              {form.sevas.map((x, i) => {
                const today = data.by_seva.find((b) => b.seva.toLowerCase() === x.name.toLowerCase())?.people ?? 0;
                return (
                  <li key={i} className="grid gap-2 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-center">
                    <div className="min-w-0">
                      <p className={`font-medium ${x.on ? "text-ink" : "text-ink-muted line-through"}`}>{x.name}</p>
                      <p className="text-xs text-ink-muted">{number(today)} donated today</p>
                    </div>
                    <Input
                      value={x.text}
                      onChange={(e) => setSeva(i, { text: e.target.value })}
                      aria-label={`Words for {{2}} for ${x.name}`}
                      disabled={!x.on}
                      placeholder="What fills {{2}}"
                    />
                    <div className="flex items-center gap-2">
                      <Toggle on={x.on} onChange={(on) => setSeva(i, { on })} label={`Thank ${x.name} donors`} />
                      {!s.sevas.some((y) => y.name === x.name) && (
                        <Button size="xs" variant="ghost" icon="trash" aria-label="Remove" onClick={() => set({ sevas: form.sevas.filter((_, j) => j !== i) })} />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {unlisted.map((u) => (
                <Button
                  key={u.seva}
                  size="sm"
                  variant="secondary"
                  icon="plus"
                  onClick={() => set({ sevas: [...form.sevas, { name: u.seva, text: `Pitru paksha ${u.seva}`, on: true }] })}
                >
                  Add {u.seva}
                </Button>
              ))}
              <Button
                loading={saving}
                disabled={!changed}
                onClick={() => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const { enabled, ...rest } = form;
                  void save(rest, "Saved");
                }}
              >
                Save
              </Button>
            </div>
          </Card>

          <Card padded={false}>
            <div className="px-4 pt-4 sm:px-5">
              <CardHeader title="Donors" icon="users" subtitle="Everyone who donated on the page that day, once each." />
            </div>
            {!data.rows.length ? (
              <EmptyState
                icon="message"
                title="Nobody yet"
                message={s.enabled ? "Donors appear here within two minutes of donating." : "Switch it on and donors appear here as they donate."}
              />
            ) : (
              <TableShell>
                <table className="w-full text-sm">
                  <Thead>
                    <Th>Donor</Th>
                    <Th>Seva</Th>
                    <Th align="right">Amount</Th>
                    <Th>Donated</Th>
                    <Th>Message</Th>
                    <Th align="right">{""}</Th>
                  </Thead>
                  <Tbody>
                    {data.rows.map((r) => (
                      <tr key={r.id}>
                        <Td>
                          <p className="font-medium text-ink">{r.name || "—"}</p>
                          <p className="text-xs tabular-nums text-ink-muted">{r.phone}</p>
                        </Td>
                        <Td>
                          <p className="text-ink">{r.seva || "—"}</p>
                          {r.seva_text && <p className="text-xs text-ink-muted">“{r.seva_text}”</p>}
                        </Td>
                        <Td align="right">{r.amount ? currency(Number(r.amount)) : "—"}</Td>
                        <Td>{r.donated_at ? clockTime(r.donated_at) : "—"}</Td>
                        <Td>
                          <Badge tone={STATUS[r.status].tone} dot>
                            {STATUS[r.status].label}
                          </Badge>
                          <p className="mt-0.5 text-xs text-ink-muted">
                            {r.status === "sent" && r.sent_at
                              ? `at ${clockTime(r.sent_at)}`
                              : r.status === "waiting" && r.send_at
                              ? `at ${clockTime(r.send_at)}`
                              : r.error ?? ""}
                          </p>
                        </Td>
                        <Td align="right">
                          {r.status === "failed" && (
                            <Button
                              size="xs"
                              variant="secondary"
                              icon="refresh"
                              onClick={async () => {
                                try {
                                  await apiClient.post(`/api/wa-thanks/${r.id}/retry`, {});
                                  toast("Trying again");
                                  setReload((n) => n + 1);
                                } catch (e) {
                                  toast.error("Could not retry", e instanceof Error ? e.message : undefined);
                                }
                              }}
                            >
                              Try again
                            </Button>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </Tbody>
                </table>
              </TableShell>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
