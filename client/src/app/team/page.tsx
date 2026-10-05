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
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  TableShell,
  Tbody,
  Td,
  Th,
  Thead,
  Toggle,
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
    blurb: "Calling, follow-ups and reminders. Can view donors.",
  },
  {
    value: "accountant",
    label: "Accountant",
    blurb: "Donations, receipts and reports.",
  },
  {
    value: "volunteer_coordinator",
    label: "Volunteer coordinator",
    blurb: "Seva, events and people.",
  },
  {
    value: "admin",
    label: "Administrator",
    blurb: "Everything, including accounts and settings.",
  },
];

// The dropdown carries each role's one-line description as its hint, so the
// person choosing reads what the role can reach at the moment they choose it
// rather than matching a label against the table of blurbs further down.
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r.value, label: r.label, hint: r.blurb }));

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
      setError(e instanceof Error ? e.message : "Could not load. Try again.");
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
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      // Reload anyway: the row on screen is now showing a change that was
      // refused, and leaving it there would be a lie.
      await load();
    }
  }

  if (user && user.role !== "admin") {
    return (
      <div>
        <PageHeader eyebrow="Setup" title="Team" subtitle="Who can sign in" />
        <Card>
          <EmptyState
            icon="shield"
            title="Administrators only"
            message="Ask an admin for access."
          />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Setup"
        title="Team"
        subtitle="Who can sign in"
        actions={
          <Button icon="userPlus" onClick={() => setShowNew(true)}>
            Add member
          </Button>
        }
      />

      {notice && (
        <Alert tone="good" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      {/* The header sits above the table rather than around it: a TableShell
          already draws a bordered, shadowed surface and wrapping it in a card
          stacked a second one behind it. */}
      <CardHeader
        icon="users"
        title={`${users.filter((u) => u.active).length} active`}
        subtitle="Turn off to stop sign-in. Their calls stay."
      />

      <TableShell>
        <Thead>
          <Th>Name</Th>
          <Th>Role</Th>
          <Th align="right">Leads</Th>
          <Th align="right">Calls, 7 days</Th>
          <Th>Last signed in</Th>
          <Th align="center">Can sign in</Th>
          <Th align="right">Password</Th>
        </Thead>
        {loading ? (
          <SkeletonRows rows={5} cols={7} />
        ) : (
          <Tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                <Td>
                  <Input
                    defaultValue={u.name}
                    aria-label={`Name for ${u.email}`}
                    onBlur={(e) => e.target.value !== u.name && e.target.value.trim() && void save(u.id, { name: e.target.value })}
                  />
                  <p className="mt-1 text-2xs text-ink-muted">{u.email}</p>
                </Td>
                <Td>
                  <Select
                    value={u.role}
                    onChange={(v) => void save(u.id, { role: v })}
                    className="min-w-[12rem]"
                    ariaLabel={`Role for ${u.name}`}
                    options={ROLE_OPTIONS}
                  />
                </Td>
                <Td align="right" className="tabular-nums">
                  {u.assigned_leads ? (
                    <>
                      {number(u.open_leads)}
                      <span className="text-ink-faint"> / {number(u.assigned_leads)}</span>
                    </>
                  ) : (
                    <span className="text-ink-faint">—</span>
                  )}
                </Td>
                <Td align="right" className="tabular-nums">
                  {u.calls_7d ? number(u.calls_7d) : <span className="text-ink-faint">—</span>}
                </Td>
                <Td className="text-xs text-ink-muted">
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
                  <Button size="sm" variant="secondary" icon="shield" onClick={() => setResetting(u)}>
                    Set password
                  </Button>
                </Td>
              </tr>
            ))}
          </Tbody>
        )}
      </TableShell>

      <Card className="mt-5">
        <CardHeader icon="help" title="Roles" />
        <dl className="space-y-3">
          {ROLES.map((r) => (
            <div key={r.value}>
              <dt className="text-sm font-medium text-ink">{r.label}</dt>
              <dd className="text-sm text-ink-muted">{r.blurb}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {showNew && (
        <NewUserDialog
          onClose={() => setShowNew(false)}
          onDone={async (name) => {
            setShowNew(false);
            setNotice(`${name} can now sign in. Share the password with them.`);
            await load();
          }}
        />
      )}

      {resetting && (
        <PasswordDialog
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setNotice(`Password set. Share it with ${resetting.name}.`);
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
    <Modal
      title="Add member"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!name.trim() || !email.trim() || password.length < 8}
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
                setError(e instanceof Error ? e.message : "Could not add. Try again.");
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
        <Field label="Name" htmlFor="new-user-name" required>
          <Input id="new-user-name" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="E-mail ID" htmlFor="new-user-email" required>
          <Input
            id="new-user-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="off"
          />
        </Field>
      </div>

      <Field
        label="Role"
        className="mt-3"
        hint={ROLES.find((r) => r.value === role)?.blurb}
      >
        <Select value={role} onChange={setRole} ariaLabel="Role" options={ROLE_OPTIONS} />
      </Field>

      <Field
        label="Password"
        htmlFor="new-user-password"
        className="mt-3"
        hint="They can change it later."
        required
      >
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Input
              id="new-user-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              placeholder="At least 8 characters"
            />
          </div>
          <Button variant="secondary" icon="sparkle" onClick={suggest}>
            Suggest
          </Button>
        </div>
      </Field>
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
    <Modal
      title={`New password for ${user.name}`}
      onClose={onClose}
      tone="danger"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {/* Destructive, so it is styled as such: this overwrites whatever
              password the person is using now, and there is no email on this
              deployment to send them the new one - if it is set by mistake,
              they are locked out until somebody tells them. */}
          <Button
            variant="dangerSoft"
            loading={busy}
            disabled={password.length < 8}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await apiClient.post(`/api/auth/users/${user.id}/password`, { new_password: password });
                onDone();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Could not set password. Try again.");
                setBusy(false);
              }
            }}
          >
            Set password
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      {/* Both facts matter at exactly this moment: a JWT already issued keeps
          working until it expires, so a reset does not sign anyone out, and
          nothing sends the new password anywhere. */}
      <Alert tone="warn">
        Devices already signed in stay signed in. DRM does not send this password. Tell {user.name} yourself.
      </Alert>
      <Field label="New password" htmlFor="reset-password" required>
        <Input
          id="reset-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
      </Field>
    </Modal>
  );
}
