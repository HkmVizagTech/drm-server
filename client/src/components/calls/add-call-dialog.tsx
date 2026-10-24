"use client";

// Add a call from its recording.
//
// For a call on a number DRM does not know: the phone app never saw it, so it
// has no talk time and is not counted. The caller says which donor it was,
// attaches the recording the phone made, and DRM takes the talk time from the
// recording itself. There is deliberately no field for a time: a time anybody
// can type is not worth counting, and a recording is the proof the call
// happened.
//
// If it is an existing donor, the number becomes their other number, so the
// next call from it matches by itself.

import { useEffect, useRef, useState } from "react";
import { api, apiClient } from "@/lib/api";
import { formatPhone } from "@/lib/calling";
import { Alert, Button, Field, Input, Modal, SearchInput, SegmentedControl, Select, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";

interface Donor {
  /** A lead is attached as it is; a donor who is not a lead yet becomes one. */
  kind: "lead" | "person";
  id: string;
  name: string | null;
  phone: string;
  note: string | null;
}

interface SearchResult {
  leads: { id: string; name: string | null; phone: string; city: string | null; status_label: string | null }[];
  people: { id: string; name: string; phone: string; lead_id: string | null }[];
}

const digits10 = (v: string) => v.replace(/\D/g, "").slice(-10);

/** Now, as the value a datetime-local box takes (the browser's own clock). */
function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

type Ask = { code: "alt_taken" | "duplicate"; text: string } | null;

export function AddCallDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [phone, setPhone] = useState("");
  const [when, setWhen] = useState(nowLocal);
  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const [who, setWho] = useState<"existing" | "new">("existing");
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Donor[] | null>(null);
  const [chosen, setChosen] = useState<Donor | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (who !== "existing" || q.trim().length < 2) {
      const t = window.setTimeout(() => setFound(null), 0);
      return () => window.clearTimeout(t);
    }
    let live = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await apiClient.get<SearchResult>(`/api/crm/search?q=${encodeURIComponent(q.trim())}`);
        if (!live) return;
        const seen = new Set<string>();
        const rows: Donor[] = [];
        for (const l of r.leads) {
          seen.add(l.phone);
          rows.push({ kind: "lead", id: l.id, name: l.name, phone: l.phone, note: [l.city, l.status_label].filter(Boolean).join(" · ") || null });
        }
        for (const p of r.people) {
          if (p.lead_id || seen.has(digits10(p.phone))) continue;
          rows.push({ kind: "person", id: p.id, name: p.name, phone: digits10(p.phone), note: "Donor" });
        }
        setFound(rows);
      } catch {
        if (live) setFound([]);
      }
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [q, who]);

  const typed = digits10(phone);
  const ready =
    !!file && typed.length === 10 && !!when && (who === "existing" ? !!chosen : name.trim().length >= 2);

  async function send(extra: Record<string, string> = {}) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setAsk(null);
    const params = new URLSearchParams({
      phone: typed,
      started_at: new Date(when).toISOString(),
      direction,
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(who === "existing" && chosen ? (chosen.kind === "lead" ? { lead_id: chosen.id } : { person_id: chosen.id }) : {}),
      ...(who === "new" ? { name: name.trim() } : {}),
      ...extra,
    });
    try {
      const r = await api<{ message: string }>(`/api/unmatched-calls?${params}`, {
        method: "POST",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": encodeURIComponent(file.name) },
      });
      onAdded(r.message);
    } catch (e) {
      const err = e as Error & { status?: number; code?: string };
      if (err.status === 409 && (err.code === "alt_taken" || err.code === "duplicate")) {
        setAsk({ code: err.code, text: err.message });
      } else {
        setError(err.message || "Could not add the call. Try again.");
      }
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a call from a recording"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="check" disabled={!ready} loading={busy} onClick={() => void send()}>
            Add call
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          For a call on a number DRM does not know. The talk time is taken from the recording, so it cannot be typed.
        </p>
        {error && <Alert tone="danger">{error}</Alert>}
        {ask && (
          <Alert
            tone="warn"
            action={
              <Button size="xs" variant="secondary" disabled={busy} onClick={() => void send(ask.code === "alt_taken" ? { replace_alt: "1" } : { force: "1" })}>
                {ask.code === "alt_taken" ? "Replace and add" : "Add anyway"}
              </Button>
            }
          >
            {ask.text}
          </Alert>
        )}

        <Field label="Recording of the call" required hint="mp3, m4a, wav, amr or 3gp - the file the phone made.">
          <input
            ref={fileInput}
            type="file"
            accept="audio/*,.m4a,.mp3,.amr,.awb,.3gp,.wav,.aac,.ogg,.opus"
            className="sr-only"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex items-center gap-3">
            <Button variant="secondary" icon="upload" onClick={() => fileInput.current?.click()}>
              {file ? "Change file" : "Choose the recording"}
            </Button>
            {file && <span className="min-w-0 truncate text-sm text-ink">{file.name}</span>}
          </div>
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Number the call was on" htmlFor="uc-phone" required>
            <Input id="uc-phone" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="10-digit mobile number" />
          </Field>
          <Field label="When was the call" htmlFor="uc-when" required>
            <Input id="uc-when" type="datetime-local" value={when} max={nowLocal()} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <Field label="Who rang" className="sm:col-span-2">
            <Select
              value={direction}
              onChange={(v) => setDirection(v === "outbound" ? "outbound" : "inbound")}
              ariaLabel="Who rang"
              options={[
                { value: "inbound", label: "They rang me" },
                { value: "outbound", label: "I rang them" },
              ]}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <SegmentedControl
            options={[
              { value: "existing", label: "A donor already in DRM" },
              { value: "new", label: "A new donor" },
            ]}
            value={who}
            onChange={(v) => setWho(v)}
          />
          {who === "existing" ? (
            <>
              <p className="text-xs text-ink-muted">
                Their name or usual number. This number is then saved as their other number, so the next call from it
                matches by itself.
              </p>
              {chosen ? (
                <div className="flex items-center gap-3 rounded-control border border-brand-600 bg-brand-50 px-3 py-2">
                  <Icon name="user" size={15} className="text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                    {chosen.name || formatPhone(chosen.phone)}
                    <span className="ml-2 font-normal tabular-nums text-ink-muted">{formatPhone(chosen.phone)}</span>
                  </span>
                  <Button variant="ghost" size="xs" onClick={() => setChosen(null)}>
                    Change
                  </Button>
                </div>
              ) : (
                <>
                  <SearchInput value={q} onChange={setQ} placeholder="Search name or mobile number" />
                  <div className="max-h-48 space-y-1.5 overflow-y-auto pr-1">
                    {found && !found.length && <p className="py-3 text-center text-sm text-ink-muted">No one found.</p>}
                    {found?.map((d) => (
                      <button
                        key={`${d.kind}:${d.id}`}
                        type="button"
                        onClick={() => setChosen(d)}
                        className="flex w-full items-center gap-3 rounded-control border border-line-soft px-3 py-2 text-left hover:bg-sunken"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{d.name || formatPhone(d.phone)}</span>
                          <span className="block truncate text-xs text-ink-muted">
                            {[formatPhone(d.phone), d.note].filter(Boolean).join(" · ")}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          ) : (
            <Field label="Donor's name" htmlFor="uc-name" required hint="Added to DRM with this number, as your donor.">
              <Input id="uc-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
            </Field>
          )}
        </div>

        <Field label="Note (optional)" htmlFor="uc-note">
          <Textarea id="uc-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="What the call was about" />
        </Field>
      </div>
    </Modal>
  );
}
