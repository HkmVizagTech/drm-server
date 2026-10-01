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
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Input,
  PageHeader,
  Skeleton,
  Textarea,
  buttonSecondary,
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
        eyebrow="Calling"
        title="My links"
        subtitle="Set these up before a shift, and they are one tap away on every call"
        actions={
          <>
            {/* A next/link anchor wearing the button class rather than
                LinkButton: LinkButton is a plain <a>, which would drop out of
                the client router. */}
            <Link href="/calling/queue" className={buttonSecondary}>
              Back to calling
            </Link>
            <Button icon={adding ? "x" : "plus"} onClick={() => setAdding((v) => !v)}>
              {adding ? "Cancel" : "Add a link"}
            </Button>
          </>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

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
          <div className="space-y-2 px-5 pb-5">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : !mine.length ? (
          <EmptyState
            icon="link"
            title="No presets of your own yet"
            message="Copy one of the temple's links below and change the wording, or add your own campaign link with its UTM."
          />
        ) : (
          <ul className="divide-y divide-line-soft border-t border-line-soft">
            {mine.map((l, i) => (
              <li key={l.id} className="px-5 py-3">
                <div className="flex flex-wrap items-start gap-3">
                  {/* Order matters here: the first preset is the one the picker
                      opens on, so moving one to the top is a real action. */}
                  <div className="flex flex-none flex-col gap-0.5">
                    <IconButton
                      name="chevronUp"
                      label={`Move ${l.label} up`}
                      size="xs"
                      variant="secondary"
                      onClick={() => void move(l, -1)}
                      disabled={i === 0}
                    />
                    <IconButton
                      name="chevronDown"
                      label={`Move ${l.label} down`}
                      size="xs"
                      variant="secondary"
                      onClick={() => void move(l, 1)}
                      disabled={i === mine.length - 1}
                    />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{l.label}</span>
                      {i === 0 && <Badge tone="brand">picked by default</Badge>}
                      {l.use_count > 0 && (
                        <span className="text-xs text-ink-faint">
                          sent {l.use_count} time{l.use_count === 1 ? "" : "s"}
                        </span>
                      )}
                      {!l.active && <Badge tone="neutral">off</Badge>}
                    </div>
                    <p className="truncate text-xs text-ink-muted" title={l.url}>
                      {l.url}
                    </p>
                  </div>

                  <div className="flex items-center gap-1 whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={editing === l.id ? "x" : "edit"}
                      onClick={() => setEditing(editing === l.id ? null : l.id)}
                    >
                      {editing === l.id ? "Close" : "Edit"}
                    </Button>
                    <Button variant="dangerSoft" size="sm" icon="trash" onClick={() => void remove(l)}>
                      Delete
                    </Button>
                  </div>
                </div>

                {editing === l.id && (
                  <div className="mt-3 rounded-card bg-sunken p-3">
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
        <ul className="divide-y divide-line-soft border-t border-line-soft">
          {shared.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <span className="font-medium text-ink">{l.label}</span>
                <p className="truncate text-xs text-ink-muted" title={l.url}>
                  {l.url}
                </p>
              </div>
              <Button variant="secondary" icon="copy" onClick={() => void copyToMine(l)}>
                Copy to my links
              </Button>
            </li>
          ))}
        </ul>
        <p className="border-t border-line-soft px-5 py-4 text-xs text-ink-muted">
          Shared links are managed in{" "}
          <Link href="/calling/settings" className="text-brand-700 hover:underline">
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
        <Field label="What to call it">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Govardhan Puja 2026"
          />
        </Field>
        <Field label="Seva name, as a donor would say it">
          <Input
            value={seva}
            onChange={(e) => setSeva(e.target.value)}
            placeholder="Govardhan Puja Seva"
          />
        </Field>
      </div>

      <Field label="The link, UTM and all">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://harekrishnavizag.org/govardhan?utm_source=call&utm_medium=whatsapp&utm_campaign=govardhan-2026"
          className="text-xs"
        />
      </Field>

      <Field label="The message that goes with it">
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="resize-y" />
      </Field>

      <p className="text-xs text-ink-faint">
        In the message: <code className="text-ink-muted">{"{name}"}</code>{" "}
        <code className="text-ink-muted">{"{seva}"}</code> <code className="text-ink-muted">{"{link}"}</code>{" "}
        <code className="text-ink-muted">{"{amount}"}</code>. In the link:{" "}
        <code className="text-ink-muted">{"{lead}"}</code> <code className="text-ink-muted">{"{caller}"}</code> — so a
        donation that came from a call can be told apart from one that arrived on its own.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex gap-2">
        <Button onClick={() => void submit()} disabled={!label.trim() || !url.trim()} loading={busy}>
          {initial ? "Save changes" : "Add it"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
