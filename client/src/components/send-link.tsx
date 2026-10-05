"use client";

// "Shall I send you the link?"
//
// The most common sentence on a fundraising call, and until now the most
// expensive one: answering it meant leaving the call, finding the seva page on
// the site, copying the URL, opening WhatsApp, finding the donor and typing a
// message. So callers said "search for our website" instead, and the donation
// did not happen.
//
// Here it is: pick the seva, glance at the message, press the green button.
// WhatsApp opens on this machine already in that donor's chat with the text
// written.
//
// HOW IT OPENS WHATSAPP
// wa.me click-to-chat, from the caller's OWN WhatsApp - not the Business API.
// No Meta template to get approved, no per-message cost, and the reply lands
// in the app the caller is already watching. The cost of that trade is that
// DRM cannot know whether they actually pressed send, so the history records
// "opened WhatsApp to send X" and never claims more than that.
//
// WHY THE MESSAGE IS EDITABLE
// A script that cannot be changed gets pasted verbatim into conversations it
// does not fit, and donors can tell. The saved message is a starting point:
// the caller adjusts the one line that matters and sends.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { Alert, Button, Card, Checkbox, Field, Input, Select, Textarea } from "@/components/ui";

export interface SavedLink {
  id: string;
  label: string;
  url: string;
  site: string | null;
  seva_name: string | null;
  message: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  use_count: number;
}

export function SendLink({
  leadId,
  leadName,
  expectedAmount,
  onSent,
  compact = false,
}: {
  leadId: string;
  leadName?: string | null;
  expectedAmount?: string | number | null;
  onSent?: () => void;
  compact?: boolean;
}) {
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [chosen, setChosen] = useState("");
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sentLabel, setSentLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ links: SavedLink[] }>("/api/crm/links");
      setLinks(d.links);
      // Open on the caller's own first preset if they have one, else the
      // busiest shared link. A caller working one campaign sends the same link
      // forty times, and making them choose it forty times is forty chances to
      // pick the wrong one. The server already returns personal presets first.
      setChosen((c) => c || d.links[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load links.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const link = links.find((l) => l.id === chosen) ?? null;

  // A preview of what the donor will receive, with the tokens filled in the
  // same way the server will fill them. Shown rather than described, because
  // "{name}" in a box is not something a caller can check at a glance.
  const preview = (link?.message ?? "Hare Krishna {name}, here is the link: {link}")
    .replace(/\{name\}/g, leadName?.trim() || "ji")
    .replace(/\{seva\}/g, link?.seva_name ?? "seva")
    .replace(/\{caller\}/g, "")
    .replace(
      /\{amount\}/g,
      expectedAmount ? `₹${Number(expectedAmount).toLocaleString("en-IN")}` : ""
    )
    .replace(/\{link\}/g, link?.url ?? "");

  // Reset the edited text whenever the chosen link changes, or a caller's
  // tweak for one donor silently follows them to the next.
  useEffect(() => {
    setEditing(false);
    setMessage("");
  }, [chosen, leadId]);

  async function send() {
    if (!link || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ wa_url: string }>(`/api/crm/leads/${leadId}/send-link`, {
        link_id: link.id,
        message: editing && message.trim() ? message : undefined,
        amount: expectedAmount ?? undefined,
      });

      // A new tab rather than replacing this one: the caller is mid-call and
      // must not lose the screen they are working from.
      window.open(r.wa_url, "_blank", "noopener,noreferrer");
      setSentLabel(link.label);
      setTimeout(() => setSentLabel(null), 6000);
      onSent?.();
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not open WhatsApp");
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <>
      {!compact && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-ink">Send a link</p>
          <Button size="xs" variant="ghost" onClick={() => setAdding((v) => !v)}>
            {adding ? "Cancel" : "Add link"}
          </Button>
        </div>
      )}

      {adding ? (
        <NewLinkForm
          onDone={(created) => {
            setAdding(false);
            void load();
            if (created) setChosen(created);
          }}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={chosen}
              onChange={setChosen}
              className="flex-1 min-w-[12rem]"
              ariaLabel="Link to send"
              placeholder="Pick a link…"
              options={links.map((l) => ({
                value: l.id,
                label: l.label,
                // Two headings rather than one flat pile: a caller's own
                // presets and the temple's shared links are different things,
                // and only the first list is theirs to change.
                group: l.owner_user_id ? "My presets" : "Temple links",
                hint:
                  l.use_count > 0
                    ? `sent ${l.use_count} time${l.use_count === 1 ? "" : "s"}`
                    : undefined,
              }))}
            />
            {/* The one agreed WhatsApp green, from the shared variant. Two
                different hover treatments for it used to live in this file and
                send-qr.tsx; a caller who sends links and QRs all day saw the
                same button behave two ways. */}
            <Button
              variant="whatsapp"
              icon="message"
              onClick={() => void send()}
              disabled={!link}
              // Button blocks its own click while loading, so the guard inside
              // send() is no longer the only thing standing between an
              // impatient double-click and two WhatsApp windows.
              loading={busy}
              // The calling screen's W shortcut clicks this button rather than
              // duplicating the send logic, so the two can never drift apart.
              data-send-whatsapp
              title="Open WhatsApp chat"
            >
              WhatsApp
            </Button>
          </div>

          {compact && (
            <div className="mt-1.5 flex items-center gap-3">
              <button
                onClick={() => setAdding(true)}
                className="text-2xs text-ink-faint underline underline-offset-2 hover:text-brand-700"
              >
                Add link
              </button>
              <a
                href="/calling/links"
                className="text-2xs text-ink-faint underline underline-offset-2 hover:text-brand-700"
              >
                My links
              </a>
            </div>
          )}

          {sentLabel && (
            <Alert tone="good" className="mt-2">
              WhatsApp opened. Press send there.
            </Alert>
          )}
          {error && (
            <Alert tone="danger" className="mt-2">
              {error}
            </Alert>
          )}

          {link && (
            <div className="mt-2">
              {editing ? (
                <Textarea
                  value={message || preview}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  className="resize-y text-xs"
                />
              ) : (
                <button
                  onClick={() => {
                    setMessage(preview);
                    setEditing(true);
                  }}
                  title="Click to edit"
                  className="w-full whitespace-pre-line break-words rounded-control bg-sunken px-3 py-2 text-left text-xs text-ink-soft transition-colors [overflow-wrap:anywhere] hover:bg-brand-50"
                >
                  {preview}
                </button>
              )}
              <p className="mt-1 text-2xs text-ink-faint">
                {editing ? "Edit, then press WhatsApp." : "Click the message to edit it."}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );

  // Compact mode is dropped inside a row on the calling screen, which draws its
  // own surface - a second bordered card inside it would show a double edge.
  return compact ? body : (
    <Card padded={false} className="p-3">
      {body}
    </Card>
  );
}

/* ------------------------------------------------------------- saving one */

// The "custom link" case: a caller has a campaign URL with its own UTM and
// wants it on the list tomorrow as well.
function NewLinkForm({ onDone }: { onDone: (createdId?: string) => void }) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [seva, setSeva] = useState("");
  const [shared, setShared] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const created = await apiClient.post<{ id: string }>("/api/crm/links", {
        label,
        url,
        seva_name: seva || label,
        shared,
        message:
          "Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam",
      });
      onDone(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  // Real labels rather than placeholder-only fields: a placeholder disappears
  // the moment someone types, so a caller who tabs back to check which box
  // wanted the URL has nothing left to read.
  return (
    <div className="space-y-2">
      <Field label="Name" htmlFor="new-link-label" required>
        <Input
          id="new-link-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Govardhan Puja 2026"
        />
      </Field>
      <Field label="Link" htmlFor="new-link-url" hint="Paste the full link" required>
        <Input
          id="new-link-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://harekrishnavizag.org/…"
        />
      </Field>
      <Field label="Seva name" htmlFor="new-link-seva" hint="Optional">
        <Input
          id="new-link-seva"
          value={seva}
          onChange={(e) => setSeva(e.target.value)}
          placeholder="Annadan"
        />
      </Field>
      <Checkbox checked={shared} onChange={setShared} label="Share with everyone" />
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} disabled={!label.trim() || !url.trim()} loading={busy}>
          Save link
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDone()}>
          Cancel
        </Button>
      </div>
      <p className="text-2xs text-ink-faint">
        Tip: you can add <code className="text-ink-muted">{"{lead}"}</code> or{" "}
        <code className="text-ink-muted">{"{caller}"}</code> to the link.
      </p>
    </div>
  );
}
