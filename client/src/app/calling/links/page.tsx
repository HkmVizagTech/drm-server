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
  /** Who the donations through this link are credited to, if anybody. Set by
   *  an admin in Calling settings - the endpoint behind it is admin-only, so
   *  this screen reads it and never offers to change it. */
  credit_user_id: string | null;
  credit_user_name: string | null;
  sort_order: number;
  active: boolean;
  use_count: number;
}

/**
 * Whether this link is earning, and for whom.
 *
 * Worth a caller seeing on their own list: a preset of theirs that credits
 * nobody looks identical to one that credits them, right up until the month's
 * figures come out and the donations they remember sending are attached to no
 * one. Read-only, because the endpoint behind it is admin-only and a control
 * that answered 403 every time would be worse than none.
 */
function CreditBadge({ link, youId }: { link: LinkRow; youId?: string }) {
  if (!link.credit_user_id) return null;
  const yours = link.credit_user_id === youId;
  return (
    <Badge tone={yours ? "good" : "neutral"} icon="rupee">
      {yours ? "Counts for you" : `Counts for ${link.credit_user_name ?? "another caller"}`}
    </Badge>
  );
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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    }
  }

  async function copyToMine(l: LinkRow) {
    try {
      await apiClient.post(`/api/crm/links/${l.id}/copy`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not copy. Try again.");
    }
  }

  async function remove(l: LinkRow) {
    if (!confirm(`Delete "${l.label}"?`)) return;
    try {
      await apiClient.delete(`/api/crm/links/${l.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save order. Try again.");
      await load();
    }
  }

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow="Calling"
        title="My links"
        subtitle="Links you send on calls."
        actions={
          <>
            {/* A next/link anchor wearing the button class rather than
                LinkButton: LinkButton is a plain <a>, which would drop out of
                the client router. */}
            <Link href="/calling/queue" className={buttonSecondary}>
              Back
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
          <CardHeader title="New link" subtitle="Only you see it" />
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
            title={`My links${mine.length ? ` · ${mine.length}` : ""}`}
            subtitle="Only you see these."
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
            title="No links yet"
            message="Copy a temple link below, or add your own."
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
                      {i === 0 && <Badge tone="brand">Default</Badge>}
                      <CreditBadge link={l} youId={user?.id} />
                      {l.use_count > 0 && (
                        <span className="text-xs text-ink-faint">
                          Sent {l.use_count} time{l.use_count === 1 ? "" : "s"}
                        </span>
                      )}
                      {!l.active && <Badge tone="neutral">Off</Badge>}
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
            title={`Temple links${shared.length ? ` · ${shared.length}` : ""}`}
            subtitle="Everyone can send these. Copy one to change the words."
          />
        </div>
        <ul className="divide-y divide-line-soft border-t border-line-soft">
          {shared.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-ink">{l.label}</span>
                  {/* A shared link can be assigned to one caller: everybody
                      sends it, one person is credited for it. */}
                  <CreditBadge link={l} youId={user?.id} />
                </div>
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
        <div className="border-t border-line-soft px-5 py-4 text-xs text-ink-muted">
          <p>
            Temple links are changed in{" "}
            <Link href="/calling/settings" className="text-brand-700 hover:underline">
              Settings
            </Link>
            .
          </p>
        </div>
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Govardhan Puja 2026"
          />
        </Field>
        <Field label="Seva">
          <Input
            value={seva}
            onChange={(e) => setSeva(e.target.value)}
            placeholder="Govardhan Puja Seva"
          />
        </Field>
      </div>

      <Field label="Link">
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://harekrishnavizag.org/govardhan?utm_source=call&utm_medium=whatsapp&utm_campaign=govardhan-2026"
          className="text-xs"
        />
      </Field>

      <Field label="Message">
        <Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={5} className="resize-y" />
      </Field>

      <p className="text-xs text-ink-faint">
        Message: <code className="text-ink-muted">{"{name}"}</code>{" "}
        <code className="text-ink-muted">{"{seva}"}</code> <code className="text-ink-muted">{"{link}"}</code>{" "}
        <code className="text-ink-muted">{"{amount}"}</code>. Link:{" "}
        <code className="text-ink-muted">{"{lead}"}</code> <code className="text-ink-muted">{"{caller}"}</code>
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex gap-2">
        <Button onClick={() => void submit()} disabled={!label.trim() || !url.trim()} loading={busy}>
          {initial ? "Save" : "Add"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
