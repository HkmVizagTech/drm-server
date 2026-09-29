"use client";

// My links — the presets a caller sets up before a shift.
//
// WHY THIS IS ITS OWN SCREEN, not a corner of Settings
// Setting up presets and making a call are different moments. Before a shift a
// caller thinks about which campaigns they are working and what wording fits;
// on a call they want one dropdown and one button. Mixing the two means either
// fiddling with wording mid-conversation, or hunting through an admin screen
// for something that is really a personal working tool.
//
// It is also a permissions boundary made visible. The temple's shared links are
// everyone's — editing one changes it for the whole team, which is right for a
// festival page and wrong for one caller's phrasing. A personal preset belongs
// to one person and the server refuses to let anyone else touch it. Showing
// them in two clearly separate lists is what stops someone "just tweaking" a
// shared link and changing it under five other callers mid-shift.
//
// The usual route to a preset is Copy, not Add: the temple's Gau Seva link is
// nearly right and the caller wants their own wording or their own UTM on it.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/ui";

interface LinkRow {
  id: string;
  label: string;
  url: string;
  site: string | null;
  seva_name: string | null;
  message: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  sort_order: number;
  active: boolean;
  use_count: number;
}

const DEFAULT_MESSAGE =
  "Hare Krishna {name}, thank you for speaking with me. Here is the link for your {seva}: {link}\n\nHare Krishna Movement, Visakhapatnam";

export default function MyLinksPage() {
  const { user } = useAuth();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await apiClient.get<{ links: LinkRow[] }>("/api/crm/links");
      setLinks(d.links);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your links");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const mine = links.filter((l) => l.owner_user_id);
  const shared = links.filter((l) => !l.owner_user_id);

  async function save(id: string, body: Record<string, unknown>) {
    try {
      await apiClient.put(`/api/crm/links/${id}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
    }
  }

  async function copyToMine(l: LinkRow) {
    try {
      await apiClient.post(`/api/crm/links/${l.id}/copy`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy that link");
    }
  }

  async function remove(l: LinkRow) {
    if (!confirm(`Delete your preset "${l.label}"?`)) return;
    try {
      await apiClient.delete(`/api/crm/links/${l.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete that");
    }
  }

  // Reorder by sending the whole list, so a half-applied move can never leave
  // the screen and the stored order disagreeing.
  async function move(l: LinkRow, delta: number) {
    const ids = mine.map((x) => x.id);
    const at = ids.indexOf(l.id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(at, 1)[0]);
    setLinks((prev) => {
      const byId = new Map(prev.map((x) => [x.id, x]));
      return [...ids.map((id) => byId.get(id)!).filter(Boolean), ...shared];
    });
    try {
      await apiClient.put("/api/crm/links-order", { ids });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that order");
      await load();
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        title="My links"
        subtitle="Set these up before a shift, and they are one tap away on every call"
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/calling/queue" className={buttonSecondary}>
              Back to calling
            </Link>
            <button onClick={() => setAdding((v) => !v)} className={buttonPrimary}>
              {adding ? "Cancel" : "Add a link"}
            </button>
          </div>
        }
      />

      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>}

      {adding && (
        <Card className="mb-5">
          <CardHeader title="A new preset of your own" subtitle="Only you will see it in the picker" />
          <LinkForm
            onSave={async (body) => {
              await apiClient.post("/api/crm/links", { ...body, shared: false });
              setAdding(false);
              await load();
            }}
            onCancel={() => setAdding(false)}
          />
        </Card>
      )}

      {/* ------------------------------------------------------ my presets */}
      <Card padded={false} className="mb-5">
        <div className="px-5 pt-5">
          <CardHeader
            title={`My presets${mine.length ? ` · ${mine.length}` : ""}`}
            subtitle="Yours alone — nobody else sees or can change these. They appear at the top of the picker on a call."
          />
        </div>

        {loading ? (
          <div className="px-5 pb-5 space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-14 rounded-lg bg-slate-100 animate-pulse" />
            ))}
          </div>
        ) : !mine.length ? (
          <EmptyState
            title="No presets of your own yet"
            message="Copy one of the temple's links below and change the wording, or add your own campaign link with its UTM."
          />
        ) : (
          <ul className="divide-y divide-slate-100 border-t border-[var(--line-soft)]">
            {mine.map((l, i) => (
              <li key={l.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  {/* Order matters here: the first preset is the one the picker
                      opens on, so moving one to the top is a real action. */}
                  <div className="flex flex-col rounded-md border border-[var(--line-soft)] overflow-hidden flex-none">
                    <button
                      onClick={() => void move(l, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="px-1.5 py-0.5 text-[10px] leading-none text-slate-500 hover:bg-[var(--accent-wash)] disabled:text-slate-200 disabled:hover:bg-transparent"
                    >
                      ▲
                    </button>
                    <button
                      onClick={() => void move(l, 1)}
                      disabled={i === mine.length - 1}
                      aria-label="Move down"
                      className="px-1.5 py-0.5 text-[10px] leading-none text-slate-500 border-t border-[var(--line-soft)] hover:bg-[var(--accent-wash)] disabled:text-slate-200 disabled:hover:bg-transparent"
                    >
                      ▼
                    </button>
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{l.label}</span>
                      {i === 0 && <Badge tone="brand">picked by default</Badge>}
                      {l.use_count > 0 && (
                        <span className="text-xs text-slate-400">
                          sent {l.use_count} time{l.use_count === 1 ? "" : "s"}
                        </span>
                      )}
                      {!l.active && <Badge tone="neutral">off</Badge>}
                    </div>
                    <p className="text-xs text-slate-500 truncate" title={l.url}>
                      {l.url}
                    </p>
                  </div>

                  <div className="flex items-center gap-3 whitespace-nowrap">
                    <button
                      onClick={() => setEditing(editing === l.id ? null : l.id)}
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      {editing === l.id ? "Close" : "Edit"}
                    </button>
                    <button onClick={() => void remove(l)} className="text-xs text-red-600 hover:underline">
                      Delete
                    </button>
                  </div>
                </div>

                {editing === l.id && (
                  <div className="mt-3 rounded-lg bg-slate-50 p-3">
                    <LinkForm
                      initial={l}
                      onSave={async (body) => {
                        await save(l.id, body);
                        setEditing(null);
                      }}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ----------------------------------------------------- shared links */}
      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title={`The temple's links${shared.length ? ` · ${shared.length}` : ""}`}
            subtitle="Everyone can send these. Copy one to get your own version with your wording, rather than changing it for the whole team."
          />
        </div>
        <ul className="divide-y divide-slate-100 border-t border-[var(--line-soft)]">
          {shared.map((l) => (
            <li key={l.id} className="px-5 py-3 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-slate-900">{l.label}</span>
                <p className="text-xs text-slate-500 truncate" title={l.url}>
                  {l.url}
                </p>
              </div>
              <button onClick={() => void copyToMine(l)} className={buttonSecondary}>
                Copy to my links
              </button>
            </li>
          ))}
        </ul>
        <p className="px-5 py-4 text-xs text-slate-500 border-t border-[var(--line-soft)]">
          Shared links are managed in{" "}
          <Link href="/calling/settings" className="text-[var(--accent)] hover:underline">
            Calling settings
          </Link>{" "}
          — changing one there changes it for every caller{user?.name ? `, not just you, ${user.name.split(" ")[0]}` : ""}.
        </p>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- the form */

function LinkForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: LinkRow;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [seva, setSeva] = useState(initial?.seva_name ?? "");
  const [message, setMessage] = useState(initial?.message ?? DEFAULT_MESSAGE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onSave({ label, url, seva_name: seva || label, message });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-slate-500 mb-1">What to call it</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Govardhan Puja 2026"
            className={`${inputClass} w-full`}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-slate-500 mb-1">Seva name, as a donor would say it</span>
          <input
            value={seva}
            onChange={(e) => setSeva(e.target.value)}
            placeholder="Govardhan Puja Seva"
            className={`${inputClass} w-full`}
          />
        </label>
      </div>

      <label className="block">
        <span className="block text-xs text-slate-500 mb-1">The link, UTM and all</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://harekrishnavizag.org/govardhan?utm_source=call&utm_medium=whatsapp&utm_campaign=govardhan-2026"
          className={`${inputClass} w-full text-xs`}
        />
      </label>

      <label className="block">
        <span className="block text-xs text-slate-500 mb-1">The message that goes with it</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          className={`${inputClass} w-full text-sm resize-y`}
        />
      </label>

      <p className="text-[11px] text-slate-400">
        In the message: <code className="text-slate-500">{"{name}"}</code>{" "}
        <code className="text-slate-500">{"{seva}"}</code> <code className="text-slate-500">{"{link}"}</code>{" "}
        <code className="text-slate-500">{"{amount}"}</code>. In the link:{" "}
        <code className="text-slate-500">{"{lead}"}</code> <code className="text-slate-500">{"{caller}"}</code> — so a
        donation that came from a call can be told apart from one that arrived on its own.
      </p>

      {error && <p className="text-xs text-red-700">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={() => void submit()}
          disabled={busy || !label.trim() || !url.trim()}
          className={buttonPrimary}
        >
          {busy ? "Saving…" : initial ? "Save changes" : "Add it"}
        </button>
        <button onClick={onCancel} className={buttonSecondary}>
          Cancel
        </button>
      </div>
    </div>
  );
}
