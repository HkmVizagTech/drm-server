"use client";

// What can be done to many leads at once, from the leads screen's selection.
//
// WHY DIALOGS AND NOT DROPDOWNS IN THE BAR
// The selection bar sits at the bottom of a phone screen, and a menu that
// drops DOWN from there opens off the bottom of the glass. More to the point,
// these actions change other people's work - reassigning two hundred leads to
// the wrong caller is a morning undone - so each one gets a dialog that says
// how many people it is about to touch before it touches them.
//
// Only shown to admins and accountants: POST /leads/bulk and the list
// endpoints refuse anyone else, and a button that can only fail is worse
// than no button.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { istInputToISO, number } from "@/lib/format";
import {
  Alert,
  Button,
  Field,
  Input,
  Modal,
  SegmentedControl,
  Select,
  Skeleton,
} from "@/components/ui";
import { Icon, type IconName } from "@/components/icons";
import { toast } from "@/components/toast";

export type BulkKind = "assign" | "status" | "tag" | "untag" | "follow_up" | "preacher" | "do_not_call";

export interface BulkConfig {
  users: { id: string; name: string; role?: string }[];
  statuses: { slug: string; label: string }[];
}

export interface BulkPreacher {
  id: string;
  code: string;
  name: string | null;
}

const ACTIONS: { kind: BulkKind; label: string; hint: string; icon: IconName; danger?: boolean }[] = [
  { kind: "assign", label: "Give to a caller", hint: "Or take them off whoever has them", icon: "userPlus" },
  { kind: "status", label: "Move to a stage", hint: "A closed stage also clears their callback", icon: "arrowRight" },
  { kind: "tag", label: "Add a tag", hint: "For building a list from them later", icon: "tag" },
  { kind: "untag", label: "Remove a tag", hint: "Takes one tag off every one of them", icon: "tag" },
  { kind: "follow_up", label: "Set when to call back", hint: "The same callback time for all of them", icon: "clock" },
  { kind: "preacher", label: "Set the preacher", hint: "Who brought them in", icon: "user" },
  { kind: "do_not_call", label: "Mark do not call", hint: "They leave every queue for good", icon: "xCircle", danger: true },
];

/**
 * One dialog for every bulk change. Opens on a menu of the actions; choosing
 * one shows just the field that action needs, and "Back" returns to the menu.
 */
export function BulkActionDialog({
  ids,
  config,
  preachers,
  onClose,
  onDone,
}: {
  ids: string[];
  config: BulkConfig | null;
  preachers: BulkPreacher[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [kind, setKind] = useState<BulkKind | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = ids.length;
  const people = `${number(n)} lead${n === 1 ? "" : "s"}`;

  const choose = (k: BulkKind | null) => {
    setKind(k);
    setValue("");
    setError(null);
  };

  // What each action sends, and how its toast reads. Kept beside each other
  // so the confirmation always describes what was actually sent.
  function body(): { extra: Record<string, unknown>; said: string } | string {
    switch (kind) {
      case "assign": {
        if (!value) return "Choose who should have them";
        const name = config?.users.find((u) => u.id === value)?.name;
        return value === "none"
          ? { extra: { assigned_to: null }, said: "Taken off their callers" }
          : { extra: { assigned_to: value }, said: `Given to ${name ?? "that caller"}` };
      }
      case "status": {
        if (!value) return "Choose a stage";
        const label = config?.statuses.find((s) => s.slug === value)?.label ?? value;
        return { extra: { status: value }, said: `Moved to ${label}` };
      }
      case "tag":
      case "untag": {
        const tag = value.trim();
        if (!tag) return "Type the tag";
        return { extra: { tags: [tag] }, said: kind === "tag" ? `Tagged #${tag}` : `Removed #${tag}` };
      }
      case "follow_up":
        return value
          ? { extra: { at: istInputToISO(value) }, said: "Callback set" }
          : { extra: { at: null }, said: "Callbacks cleared" };
      case "preacher": {
        if (!value) return "Choose a preacher";
        const p = preachers.find((x) => x.id === value);
        return value === "none"
          ? { extra: { preacher_id: null }, said: "Preacher cleared" }
          : { extra: { preacher_id: value }, said: `Preacher set to ${p?.name || p?.code || "them"}` };
      }
      case "do_not_call":
        return { extra: {}, said: "Marked do not call" };
      default:
        return "Choose what to do";
    }
  }

  async function apply() {
    const b = body();
    if (typeof b === "string") return setError(b);
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ requested: number; updated: number }>("/api/crm/leads/bulk", {
        ids,
        action: kind,
        ...b.extra,
      });
      toast(`${b.said} · updated ${number(r.updated)} lead${r.updated === 1 ? "" : "s"}`);
      onDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not apply that";
      setError(msg);
      toast.error("Could not apply that", msg);
      setBusy(false);
    }
  }

  const current = ACTIONS.find((a) => a.kind === kind);

  return (
    <Modal
      title={current ? `${current.label} — ${people}` : `Change ${people}`}
      tone={kind === "do_not_call" ? "danger" : "default"}
      onClose={onClose}
      footer={
        kind ? (
          <>
            <Button variant="ghost" icon="arrowLeft" onClick={() => choose(null)} className="mr-auto">
              Back
            </Button>
            <Button
              variant={kind === "do_not_call" ? "danger" : "primary"}
              loading={busy}
              onClick={() => void apply()}
            >
              {kind === "do_not_call" ? `Mark ${people} do not call` : `Apply to ${people}`}
            </Button>
          </>
        ) : undefined
      }
    >
      {!kind ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {ACTIONS.map((a) => (
            <button
              key={a.kind}
              type="button"
              onClick={() => choose(a.kind)}
              className={`flex items-start gap-3 rounded-control border px-3.5 py-3 text-left transition-colors ${
                a.danger
                  ? "border-red-200 hover:bg-danger-wash"
                  : "border-line-soft hover:border-brand-400 hover:bg-brand-50"
              }`}
            >
              <Icon name={a.icon} size={16} className={`mt-0.5 ${a.danger ? "text-danger" : "text-brand-600"}`} />
              <span className="min-w-0">
                <span className={`block text-sm font-medium ${a.danger ? "text-danger" : "text-ink"}`}>{a.label}</span>
                <span className="block text-xs text-ink-muted">{a.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {error && <Alert tone="danger">{error}</Alert>}
          {kind === "assign" && (
            <Field label="Who should have them">
              <Select
                value={value}
                onChange={setValue}
                ariaLabel="Who should have them"
                placeholder="Choose a caller…"
                options={[
                  { value: "none", label: "Nobody — leave them unassigned" },
                  ...(config?.users ?? []).map((u) => ({
                    value: u.id,
                    label: u.name,
                    hint: u.role?.replace(/_/g, " "),
                  })),
                ]}
              />
            </Field>
          )}
          {kind === "status" && (
            <Field label="Stage">
              <Select
                value={value}
                onChange={setValue}
                ariaLabel="Stage"
                placeholder="Choose a stage…"
                options={(config?.statuses ?? []).map((s) => ({ value: s.slug, label: s.label }))}
              />
            </Field>
          )}
          {(kind === "tag" || kind === "untag") && (
            <Field label="Tag" htmlFor="bulk-tag" hint="Lower-case with dashes reads best, e.g. janmashtami-2026">
              <Input
                id="bulk-tag"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="e.g. janmashtami-2026"
                autoCapitalize="off"
              />
            </Field>
          )}
          {kind === "follow_up" && (
            <Field
              label="Call them back at"
              htmlFor="bulk-follow-up"
              hint="Temple time (IST). Leave it empty to clear their callbacks instead."
            >
              <Input
                id="bulk-follow-up"
                type="datetime-local"
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </Field>
          )}
          {kind === "preacher" && (
            <Field label="Preacher">
              <Select
                value={value}
                onChange={setValue}
                ariaLabel="Preacher"
                placeholder="Choose a preacher…"
                options={[
                  { value: "none", label: "No preacher" },
                  ...preachers.map((p) => ({ value: p.id, label: p.name ? `${p.name} (${p.code})` : p.code })),
                ]}
              />
            </Field>
          )}
          {kind === "do_not_call" && (
            <Alert tone="danger" className="mb-0">
              {people} will never appear in a calling queue again, and any callbacks booked for them are cleared.
              This cannot be undone from the leads screen.
            </Alert>
          )}
        </>
      )}
    </Modal>
  );
}

interface ListOption {
  id: string;
  name: string;
  total: number;
  members_only?: boolean;
  active: boolean;
}

/**
 * Put the selection on a calling list - an existing one, or a new list made of
 * exactly these people. Either way they are added by hand, so they stay on it
 * whatever the list's filters say.
 */
export function AddToListDialog({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [lists, setLists] = useState<ListOption[] | null>(null);
  const [listId, setListId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = `${number(ids.length)} lead${ids.length === 1 ? "" : "s"}`;

  useEffect(() => {
    apiClient
      .get<{ lists: ListOption[] }>("/api/crm/lists")
      .then((d) => {
        setLists(d.lists);
        // No lists yet: straight to making one rather than an empty dropdown.
        if (!d.lists.length) setMode("new");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the lists"));
  }, []);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (mode === "existing") {
        if (!listId) throw new Error("Choose a list");
        const r = await apiClient.post<{ changed: number }>(`/api/crm/lists/${listId}/members`, {
          lead_ids: ids,
          action: "include",
        });
        const listName = lists?.find((l) => l.id === listId)?.name ?? "the list";
        toast(`Added ${number(r.changed)} to “${listName}”`);
      } else {
        if (!name.trim()) throw new Error("Give the new list a name");
        await apiClient.post("/api/crm/lists", { name: name.trim(), members_only: true, lead_ids: ids });
        toast(`Made the list “${name.trim()}” with ${people}`);
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Add ${people} to a calling list`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={mode === "existing" ? !listId : !name.trim()}
            onClick={() => void save()}
          >
            {mode === "existing" ? "Add to the list" : "Make the list"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <SegmentedControl
        options={[
          { value: "existing", label: "An existing list" },
          { value: "new", label: "A new list" },
        ]}
        value={mode}
        onChange={setMode}
        className="mb-4"
      />
      {mode === "existing" ? (
        lists === null ? (
          <Skeleton className="h-9.5 w-full" />
        ) : (
          <Field label="Which list" hint="They stay on it whatever its filters say, until removed by hand.">
            <Select
              value={listId}
              onChange={setListId}
              ariaLabel="Which list"
              placeholder="Choose a list…"
              options={lists
                .filter((l) => l.active)
                .map((l) => ({
                  value: l.id,
                  label: l.name,
                  hint: `${number(l.total)} ${l.total === 1 ? "person" : "people"}${l.members_only ? " · hand-picked" : ""}`,
                }))}
            />
          </Field>
        )
      ) : (
        <Field
          label="Name the new list"
          htmlFor="new-list-name"
          hint="It holds exactly these people - nobody joins it by filter."
        >
          <Input
            id="new-list-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ekadashi callbacks"
          />
        </Field>
      )}
    </Modal>
  );
}
