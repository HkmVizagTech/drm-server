"use client";

// Accounts.
//
// Until now there was no way to make one. Every account was created by hand
// against the database, and /api/auth/register was open to the internet and
// handed out 'admin' to anyone who asked — which was survivable on a laptop
// and is not, now that DRM answers on a public domain.
//
// WHAT A ROLE MEANS HERE
// Said in the words of the job rather than in permissions, because whoever
// adds a caller on a Tuesday afternoon is not going to reason about route
// guards. The guards are real and live on the server; this screen only has to
// make the choice obvious.
//
// NOBODY IS DELETED
// A caller who leaves wrote every call in the log. Deleting the row would
// either orphan that history or take it with them, so an account is switched
// off: it can no longer sign in, and every call it made still says who made it.

import { useCallback, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { number, relativeDate } from "@/lib/format";
import {
  Badge,
  Card,
  CardHeader,
  Modal,
  PageHeader,
  Select,
  TableShell,
  Td,
  Th,
  Toggle,
  buttonPrimary,
  buttonSecondary,
  inputClass,
} from "@/components/ui";

interface TeamUser {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  assigned_leads: number;
  open_leads: number;
  calls_7d: number;
}

const ROLES: { value: string; label: string; blurb: string }[] = [
  {
    value: "caller",
    label: "Caller",
    blurb: "The Calling section — their queue, follow-ups, reminders and links. They can look up a donor's record but not change it.",
  },
  {
    value: "accountant",
    label: "Accountant",
    blurb: "Donations, receipts, recurring giving and reports. No access to the calling lists.",
  },
  {
    value: "volunteer_coordinator",
    label: "Volunteer coordinator",
    blurb: "Seva bookings, events and the people behind them.",
  },
  {
    value: "admin",
    label: "Administrator",
    blurb: "Everything, including creating accounts and changing settings.",
  },
];

const roleLabel = (r: string) => ROLES.find((x) => x.value === r)?.label ?? r.replace(/_/g, " ");

export default function TeamPage() {
  const { user } = useAuth();
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [resetting, setResetting] = useState<TeamUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await apiClient.get<{ users: TeamUser[] }>("/api/auth/users");
      setUsers(d.users);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the team");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(id: string, body: Record<string, unknown>) {
    setError(null);
    try {
      await apiClient.put(`/api/auth/users/${id}`, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save that");
      // Reload anyway: the row on screen is now showing a change that was
      // refused, and leaving it there would be a lie.
      await load();
    }
  }

  if (user && user.role !== "admin") {
    return (
      <div>
        <PageHeader title="Team" subtitle="Accounts and what each of them can reach" />
        <Card>
          <p className="text-sm text-slate-600">
            Only an administrator can see and change accounts. Ask one if you need access to something.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle="Who can sign in to DRM, and what each of them can reach"
        actions={
          <button onClick={() => setShowNew(true)} className={buttonPrimary}>
            Add someone
          </button>
        }
      />

      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <Card padded={false}>
        <div className="px-5 pt-5">
          <CardHeader
            title={`${users.filter((u) => u.active).length} active`}
            subtitle="Switching someone off stops them signing in and keeps every call they logged."
          />
        </div>

        <TableShell>
          <thead className="bg-slate-50/80 border-b border-[var(--line-soft)]">
            <tr>
              <Th>Name</Th>
              <Th>Can reach</Th>
              <Th align="right">Leads</Th>
              <Th align="right">Calls, 7 days</Th>
              <Th>Last signed in</Th>
              <Th align="center">Can sign in</Th>
              <Th align="right">Password</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-400">Loading…</td></tr>
            ) : (
              users.map((u) => (
                <tr key={u.id} className={`hover:bg-slate-50/60 ${u.active ? "" : "opacity-60"}`}>
                  <Td>
                    <input
                      defaultValue={u.name}
                      onBlur={(e) => e.target.value !== u.name && e.target.value.trim() && void save(u.id, { name: e.target.value })}
                      className="w-full bg-transparent font-medium text-slate-900 focus:outline-none focus:ring-1 focus:ring-[var(--accent)] rounded px-1 -mx-1"
                    />
                    <p className="text-[11px] text-slate-500">{u.email}</p>
                  </Td>
                  <Td>
                    <Select
                      value={u.role}
                      onChange={(v) => void save(u.id, { role: v })}
                      className="min-w-[11rem]"
                      options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
                    />
                  </Td>
                  <Td align="right" className="tabular-nums text-slate-600">
                    {u.assigned_leads ? (
                      <>
                        {number(u.open_leads)}
                        <span className="text-slate-300"> / {number(u.assigned_leads)}</span>
                      </>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums text-slate-700">
                    {u.calls_7d ? number(u.calls_7d) : <span className="text-slate-300">—</span>}
                  </Td>
                  <Td className="text-slate-500 text-xs">
                    {u.last_login_at ? relativeDate(u.last_login_at) : <Badge tone="neutral">Never</Badge>}
                  </Td>
                  <Td align="center">
                    <Toggle
                      on={u.active}
                      onChange={(v: boolean) => void save(u.id, { active: v })}
                      label={`${u.name} can sign in`}
                    />
                  </Td>
                  <Td align="right">
                    <button
                      onClick={() => setResetting(u)}
                      className="rounded-lg px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
                    >
                      Set password
                    </button>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </TableShell>
      </Card>

      <Card className="mt-5">
        <CardHeader title="What the roles mean" />
        <dl className="space-y-3">
          {ROLES.map((r) => (
            <div key={r.value}>
              <dt className="text-sm font-medium text-slate-900">{r.label}</dt>
              <dd className="text-sm text-slate-600">{r.blurb}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {showNew && (
        <NewUserDialog
          onClose={() => setShowNew(false)}
          onDone={async (name) => {
            setShowNew(false);
            setNotice(`${name} can now sign in. Give them the password you just set — DRM cannot email it.`);
            await load();
          }}
        />
      )}

      {resetting && (
        <PasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice(`${resetting.name}'s password is set. Tell them what it is — DRM cannot email it.`);
            setResetting(null);
          }}
        />
      )}
    </div>
  );
}

function NewUserDialog({ onClose, onDone }: { onClose: () => void; onDone: (name: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("caller");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Suggested rather than imposed, and shown in the clear, because the admin
  // has to read it out to the person anyway - there is no email on this
  // deployment to send it through.
  function suggest() {
    const words = ["tulasi", "yamuna", "govinda", "gokula", "kirtan", "mandir", "prasad", "yatra"];
    const w = words[Math.floor(Math.random() * words.length)];
    setPassword(`${w}-${Math.floor(1000 + Math.random() * 9000)}`);
  }

  return (
    <Modal title="Add someone to the team" onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-500">
          Their name
          <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} mt-1 w-full`} />
        </label>
        <label className="text-xs text-slate-500">
          Email they sign in with
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="off"
            className={`${inputClass} mt-1 w-full`}
          />
        </label>
      </div>

      <label className="mt-3 block text-xs text-slate-500">
        What they do
        <Select
          value={role}
          onChange={setRole}
          className="mt-1 w-full"
          options={ROLES.map((r) => ({ value: r.value, label: r.label }))}
        />
      </label>
      <p className="mt-1.5 text-xs text-slate-500">{ROLES.find((r) => r.value === role)?.blurb}</p>

      <label className="mt-3 block text-xs text-slate-500">
        A password to start with
        <div className="mt-1 flex gap-2">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={`${inputClass} flex-1`}
          />
          <button type="button" onClick={suggest} className={buttonSecondary}>
            Suggest one
          </button>
        </div>
      </label>
      <p className="mt-1.5 text-xs text-slate-500">
        They can change it after signing in, under their own name in the sidebar.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy || !name.trim() || !email.trim() || password.length < 8}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.post("/api/auth/register", {
                name: name.trim(),
                email: email.trim(),
                role,
                password,
              });
              onDone(name.trim());
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not create that account");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Creating…" : "Create the account"}
        </button>
      </div>
    </Modal>
  );
}

function PasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: TeamUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Modal title={`Set a password for ${user.name}`} onClose={onClose}>
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      <p className="mb-3 text-sm text-slate-600">
        They will be signed out of nothing — an existing session keeps working until it expires. Tell them the new
        password yourself; DRM has no email set up to send it.
      </p>
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="new-password"
        placeholder="At least 8 characters"
        className={`${inputClass} w-full`}
      />
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className={buttonSecondary}>Cancel</button>
        <button
          disabled={busy || password.length < 8}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await apiClient.post(`/api/auth/users/${user.id}/password`, { new_password: password });
              onDone();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not set that password");
              setBusy(false);
            }
          }}
          className={buttonPrimary}
        >
          {busy ? "Saving…" : "Set it"}
        </button>
      </div>
    </Modal>
  );
}
