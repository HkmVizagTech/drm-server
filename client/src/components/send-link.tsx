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
import { Select, buttonSecondary, inputClass } from "@/components/ui";

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
      setError(e instanceof Error ? e.message : "Could not load the saved links");
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

  const waIcon = (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="w-4 h-4">
      <path d="M17.5 14.4c-.3-.2-1.7-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.7 1-.9 1.2-.2.2-.3.2-.6.1-.3-.2-1.2-.5-2.3-1.4-.9-.8-1.4-1.7-1.6-2-.2-.3 0-.5.1-.6l.5-.5c.1-.2.2-.3.3-.5 0-.2 0-.4 0-.5 0-.2-.7-1.6-.9-2.2-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.1 3.2 5 4.5.7.3 1.3.5 1.7.6.7.2 1.4.2 1.9.1.6-.1 1.7-.7 2-1.4.2-.7.2-1.2.2-1.4-.1-.1-.3-.2-.6-.3z" />
      <path d="M12 2a10 10 0 0 0-8.6 15L2 22l5.2-1.4A10 10 0 1 0 12 2zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 12 20.2z" />
    </svg>
  );

  return (
    <div className={compact ? "" : "rounded-lg border border-[var(--line-soft)] bg-white p-3"}>
      {!compact && (
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-sm font-semibold text-slate-900">Send them a link</p>
          <button
            onClick={() => setAdding((v) => !v)}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            {adding ? "Cancel" : "Save a new link"}
          </button>
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
              ariaLabel="Which link to send"
              placeholder="Pick a link…"
              options={links.map((l) => ({
                value: l.id,
                label: l.label,
                // Two headings rather than one flat pile: a caller's own
                // presets and the temple's shared links are different things,
                // and only the first list is theirs to change.
                group: l.owner_user_id ? "My presets" : "The temple's links",
                hint:
                  l.use_count > 0
                    ? `sent ${l.use_count} time${l.use_count === 1 ? "" : "s"}`
                    : undefined,
              }))}
            />
            <button
              onClick={() => void send()}
              disabled={!link || busy}
              // The calling screen's W shortcut clicks this button rather than
              // duplicating the send logic, so the two can never drift apart.
              data-send-whatsapp
              title="Opens WhatsApp on this computer, in this donor's chat"
              className="inline-flex items-center gap-2 rounded-lg bg-[#25D366] px-4 py-2 text-sm font-semibold text-white hover:brightness-95 disabled:opacity-50 transition"
            >
              {waIcon}
              {busy ? "Opening…" : "WhatsApp"}
            </button>
          </div>

          {compact && (
            <div className="mt-1.5 flex items-center gap-3">
              <button
                onClick={() => setAdding(true)}
                className="text-[11px] text-slate-400 hover:text-[var(--accent)] underline underline-offset-2"
              >
                Save a new link
              </button>
              <a
                href="/calling/links"
                className="text-[11px] text-slate-400 hover:text-[var(--accent)] underline underline-offset-2"
              >
                My links
              </a>
            </div>
          )}

          {sentLabel && (
            <p className="mt-2 text-xs text-emerald-700">
              WhatsApp opened with the {sentLabel} link. Press send there — DRM can&apos;t do that part for you.
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-700">{error}</p>}

          {link && (
            <div className="mt-2">
              {editing ? (
                <textarea
                  value={message || preview}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={4}
                  className={`${inputClass} w-full text-xs resize-y`}
                />
              ) : (
                <button
                  onClick={() => {
                    setMessage(preview);
                    setEditing(true);
                  }}
                  title="Click to edit before sending"
                  className="w-full text-left rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600 whitespace-pre-line hover:bg-slate-100 transition-colors"
                >
                  {preview}
                </button>
              )}
              <p className="mt-1 text-[11px] text-slate-400">
                {editing ? "Edit, then press WhatsApp." : "Click the message to change it for this donor."}
              </p>
            </div>
          )}
        </>
      )}
    </div>
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
      setError(e instanceof Error ? e.message : "Could not save that link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="What to call it — Govardhan Puja 2026"
        className={`${inputClass} w-full text-sm`}
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://harekrishnavizag.org/… (paste the full link, UTM and all)"
        className={`${inputClass} w-full text-sm`}
      />
      <input
        value={seva}
        onChange={(e) => setSeva(e.target.value)}
        placeholder="Seva name as a donor would say it (optional)"
        className={`${inputClass} w-full text-sm`}
      />
      <label className="flex items-center gap-2 text-xs text-slate-600">
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} className="rounded border-slate-300" />
        Everyone can send this one
      </label>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => void save()} disabled={busy || !label.trim() || !url.trim()} className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? "Saving…" : "Save link"}
        </button>
        <button onClick={() => onDone()} className={buttonSecondary}>
          Cancel
        </button>
      </div>
      <p className="text-[11px] text-slate-400">
        Tip: the link can contain <code className="text-slate-500">{"{lead}"}</code> or{" "}
        <code className="text-slate-500">{"{caller}"}</code> — DRM fills them in, so a donation that came from a call
        can be told apart from one that arrived on its own.
      </p>
    </div>
  );
}
