"use client";

// One donor, and everything the temple holds about them.
//
// This screen was the last one still carrying its own design: six hand-rolled
// `bg-white rounded-xl shadow` cards, three raw tables with their own grey
// heads, a private modal shell, a private badge(), a private inr(), and a
// private `inputClass` that shadowed the shared one with different padding and
// a different border. It is on the shared system now, so a donor profile looks
// like the rest of DRM and a change to a control reaches it.

import { use, useEffect, useState, FormEvent } from "react";
import { apiClient } from "@/lib/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  EmptyState,
  Field,
  Input,
  LinkButton,
  Modal,
  MoneyCell,
  PageHeader,
  Select,
  Skeleton,
  SkeletonRows,
  StatTile,
  StatusBadge,
  TableShell,
  Tabs,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
} from "@/components/ui";
import { currency, dateTime, istYear, shortDate, titleCase } from "@/lib/format";

interface Person {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  pan?: string;
  roles: string[];
  date_of_birth?: string;
  anniversary_date?: string;
  prasadam_address?: string;

  // The address in parts. `address` above stays as the free-text line that
  // arrived before DRM had these, and is what display falls back to.
  address_door?: string; address_house?: string; address_street?: string; address_area?: string;
  address_city?: string; address_state?: string; address_pincode?: string; address_country?: string;
  prasadam_door?: string; prasadam_house?: string; prasadam_street?: string; prasadam_area?: string;
  prasadam_city?: string; prasadam_state?: string; prasadam_pincode?: string; prasadam_country?: string;

  // When the sites disagree about their name.
  name_alt?: string | null;
  name_alt_source?: string | null;
  name_conflict_at?: string | null;
  name_edited_at?: string | null;
  // How the last correction travelled, and whether it reached the sites.
  profile_source?: string | null;
  push_status?: string | null;
  push_error?: string | null;
  pushed_at?: string | null;
  source_sites?: string[];
}

/** The eight parts, as the form and the sites both hold them. */
interface AddressParts {
  door: string; house: string; street: string; area: string;
  city: string; state: string; pincode: string; country: string;
}

const emptyAddress = (): AddressParts => ({
  door: "", house: "", street: "", area: "", city: "", state: "", pincode: "", country: "India",
});

const readParts = (p: Person, prefix: "address" | "prasadam"): AddressParts => ({
  door: (p[`${prefix}_door` as keyof Person] as string) ?? "",
  house: (p[`${prefix}_house` as keyof Person] as string) ?? "",
  street: (p[`${prefix}_street` as keyof Person] as string) ?? "",
  area: (p[`${prefix}_area` as keyof Person] as string) ?? "",
  city: (p[`${prefix}_city` as keyof Person] as string) ?? "",
  state: (p[`${prefix}_state` as keyof Person] as string) ?? "",
  pincode: (p[`${prefix}_pincode` as keyof Person] as string) ?? "",
  country: (p[`${prefix}_country` as keyof Person] as string) ?? "India",
});

const hasParts = (a: AddressParts) =>
  !!(a.door || a.house || a.street || a.area || a.city || a.state || a.pincode);

/**
 * The address on several lines, the way an Indian postal address is read.
 *
 * Falsy parts are dropped BEFORE joining, which is the whole difference
 * between this and what a receipt printed before: building a line from
 * `${street}, ${city}, ${state} - ${pincode}` unconditionally gives
 * "123 Main St, ,  - " when only the street is known.
 */
function addressLines(a: AddressParts, fallback?: string | null): string[] {
  const lines: string[] = [];
  const building = [a.door, a.house].filter(Boolean).join(", ");
  if (building) lines.push(building);
  if (a.street) lines.push(a.street);
  if (a.area) lines.push(a.area);
  const town = [a.city, a.state].filter(Boolean).join(", ");
  const withPin = a.pincode ? (town ? `${town} - ${a.pincode}` : a.pincode) : town;
  if (withPin) lines.push(withPin);
  if (a.country && a.country.toLowerCase() !== "india") lines.push(a.country);
  if (lines.length) return lines;
  const raw = (fallback ?? "").trim();
  return raw ? raw.split(/\s*,\s*/).filter(Boolean) : [];
}

interface Donation {
  id: string;
  amount: number;
  type: string;
  purpose: string;
  payment_mode: string;
  source: string;
  receipt_generated: boolean;
  receipt_number?: string;
  receipt_url?: string;
  receipt_issued_at?: string;
  subscription_id?: string;
  external_ref?: string;
  created_at: string;
}

interface Subscription {
  id: string;
  amount: number;
  frequency: string;
  purpose: string;
  status: string;
  next_charge_date?: string;
  created_at: string;
}

interface PrasadamDelivery {
  id: string;
  address: string;
  status: string;
  courier_name?: string;
  tracking_number?: string;
  dispatched_at?: string;
  delivered_at?: string;
  notes?: string;
  created_at: string;
}

interface PersonNote {
  id: string;
  note: string;
  author_name?: string;
  created_at: string;
}

interface Profile {
  person: Person;
  donations: Donation[];
  subscriptions: Subscription[];
  prasadam_deliveries: PrasadamDelivery[];
  notes: PersonNote[];
  lifetime: { total: number; by_year: { year: string; total: number; count: number }[] };
}

/** One labelled fact in the summary card. */
function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-ink-muted">{label}</p>
      <div className="mt-0.5 text-sm font-medium text-ink">{children}</div>
    </div>
  );
}

const TABS = [
  { key: "donations", label: "Donations", icon: "receipt" },
  { key: "subscriptions", label: "Recurring", icon: "refresh" },
  { key: "prasadam", label: "Prasadam", icon: "box" },
  { key: "notes", label: "Notes", icon: "fileText" },
] as const;

export default function PersonProfilePage({ params }: PageProps<"/people/[id]">) {
  const { id } = use(params);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showReceiptFor, setShowReceiptFor] = useState<Donation | null>(null);
  const [showNewSubscription, setShowNewSubscription] = useState(false);
  const [showNewDelivery, setShowNewDelivery] = useState(false);
  const [updatingDelivery, setUpdatingDelivery] = useState<PrasadamDelivery | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncNote, setSyncNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [tab, setTab] = useState<string>("donations");

  const load = () => {
    setLoading(true);
    apiClient
      .get<Profile>(`/api/people/${id}/profile`)
      .then(setProfile)
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  const updateSubscriptionStatus = async (subId: string, status: string) => {
    await apiClient.put(`/api/subscriptions/${subId}`, { status });
    load();
  };

  const syncFromHkmv = async () => {
    setSyncing(true);
    setSyncNote(null);
    try {
      const result = await apiClient.post<{ donationsSynced: number; subscriptionsSynced: number; deliveriesSynced: number }>(
        `/api/people/${id}/sync-hkmv`,
        {}
      );
      setSyncNote({
        tone: "ok",
        text: `Synced ${result.donationsSynced} donation${result.donationsSynced === 1 ? "" : "s"}, ${result.subscriptionsSynced} subscription${result.subscriptionsSynced === 1 ? "" : "s"}, ${result.deliveriesSynced} prasadam ${result.deliveriesSynced === 1 ? "delivery" : "deliveries"} from hkmsite2.0.`,
      });
      load();
    } catch (err) {
      setSyncNote({ tone: "err", text: err instanceof Error ? err.message : "Sync failed" });
    } finally {
      setSyncing(false);
    }
  };

  // Ask the originating donation site to re-send its WhatsApp receipt. The
  // receipt template, numbering and PDF all live on that site, so DRM asks
  // rather than composing its own - otherwise donors get two receipts that
  // don't match.
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [resendNote, setResendNote] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  const resendReceipt = async (donationId: string) => {
    setResendingId(donationId);
    setResendNote(null);
    try {
      const r = await apiClient.post<{ sentTo?: string; receiptNumber?: string }>(
        `/api/donations/${donationId}/resend-receipt`,
        {}
      );
      setResendNote({
        tone: "ok",
        text: `Receipt ${r.receiptNumber ?? ""} re-sent${r.sentTo ? ` to ${r.sentTo}` : ""}.`,
      });
    } catch (err) {
      setResendNote({
        tone: "err",
        text: err instanceof Error ? err.message : "Could not resend the receipt.",
      });
    } finally {
      setResendingId(null);
    }
  };

  const downloadReceiptFile = async (donationId: string, receiptNumber?: string) => {
    try {
      const blob = await apiClient.getBlob(`/api/donations/${donationId}/receipt-file`);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (err) {
      alert(err instanceof Error ? err.message : `Could not download receipt${receiptNumber ? ` ${receiptNumber}` : ""}`);
    }
  };

  const addNote = async (e: FormEvent) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setSavingNote(true);
    try {
      await apiClient.post(`/api/people/${id}/notes`, { note: noteText.trim() });
      setNoteText("");
      load();
    } finally {
      setSavingNote(false);
    }
  };

  if (loading) return <ProfileSkeleton />;
  if (notFound || !profile)
    return (
      <div>
        <Alert tone="danger">Person not found.</Alert>
        <LinkButton href="/people" icon="arrowLeft">
          Back to people
        </LinkButton>
      </div>
    );

  const { person, donations, subscriptions, prasadam_deliveries, notes, lifetime } = profile;

  // The latest of the dates rather than donations[0]: the profile endpoint
  // makes no promise about the order it returns donations in, so reading the
  // first row would show whichever one happened to come back first as the most
  // recent gift.
  const lastDonationAt = donations.reduce<string | undefined>(
    (latest, d) => (!latest || d.created_at > latest ? d.created_at : latest),
    undefined
  );

  const homeLines = addressLines(readParts(person, "address"), person.address);
  const ownPrasadam = readParts(person, "prasadam");
  const prasadamLines = hasParts(ownPrasadam)
    ? addressLines(ownPrasadam, person.prasadam_address)
    : addressLines(readParts(person, "address"), person.prasadam_address || person.address);
  const prasadamSameAsHome = !hasParts(ownPrasadam) && !person.prasadam_address;

  return (
    <div>
      <PageHeader
        eyebrow="Donors"
        title={person.name}
        subtitle={`${person.phone}${person.email ? ` · ${person.email}` : ""}`}
        actions={
          <>
            <LinkButton href="/people" icon="arrowLeft" variant="ghost">
              Back to people
            </LinkButton>
            <Button variant="secondary" icon="refresh" loading={syncing} onClick={syncFromHkmv}>
              Sync from HKMV
            </Button>
            <Button icon="edit" onClick={() => setShowEdit(true)}>
              Edit profile
            </Button>
          </>
        }
      />

      {syncNote && <Alert tone={syncNote.tone === "ok" ? "good" : "danger"}>{syncNote.text}</Alert>}
      {resendNote && <Alert tone={resendNote.tone === "ok" ? "good" : "danger"}>{resendNote.text}</Alert>}

      {/* The sites disagree about this donor's name. Worth showing at the top
          of the record rather than only in the edit form: somebody reading the
          page should know the spelling is contested before they read it out on
          a call. */}
      {person.name_alt && (
        <Alert tone="warn" title="The sites disagree about this donor's name">
          <strong>{person.name_alt_source === "annadan" ? "annadan" : "The donation site"}</strong> has this donor
          as <strong>{person.name_alt}</strong>. Open Edit profile to settle which spelling is right — it will be
          sent to both sites.
        </Alert>
      )}

      {person.push_status === "failed" || person.push_status === "partial" ? (
        <Alert tone="danger" title="The last change did not reach the sites">
          The last change here did not reach {person.push_status === "partial" ? "every site" : "the sites"}.
          {person.push_error && <span className="mt-0.5 block text-xs">{person.push_error}</span>}
        </Alert>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile label="Lifetime giving" value={currency(lifetime.total)} icon="rupee" accent="brand" />
        <StatTile label="Donations" value={donations.length} icon="receipt" />
        <StatTile label="Last donation" value={shortDate(lastDonationAt)} icon="calendar" />
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader title="Donor details" icon="user" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Detail label="Phone">{person.phone}</Detail>
            <Detail label="Email">{person.email || "—"}</Detail>
            <Detail label="PAN">{person.pan || "—"}</Detail>
            <Detail label="Date of birth">{shortDate(person.date_of_birth)}</Detail>
            <Detail label="Anniversary">{shortDate(person.anniversary_date)}</Detail>
          </div>

          <div className="mt-4 grid gap-4 border-t border-line-soft pt-4 sm:grid-cols-2">
            <Detail label="Address">
              {homeLines.length ? (
                <div className="leading-snug">
                  {homeLines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </div>
              ) : (
                <span className="text-ink-faint">Not set</span>
              )}
            </Detail>
            <Detail label="Prasadam delivery address">
              {prasadamLines.length ? (
                <div className="leading-snug">
                  {prasadamLines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                  {prasadamSameAsHome && (
                    <p className="mt-0.5 text-xs font-normal text-ink-faint">Same as their address</p>
                  )}
                </div>
              ) : (
                <span className="text-ink-faint">Not set</span>
              )}
            </Detail>
          </div>

          {person.roles.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5 border-t border-line-soft pt-4">
              {person.roles.map((r) => (
                <Badge key={r} tone="brand">
                  {titleCase(r)}
                </Badge>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Giving by year" icon="chart" />
          {lifetime.by_year.length ? (
            <div className="space-y-2">
              {lifetime.by_year.map((y) => (
                <div
                  key={y.year}
                  className="flex items-baseline justify-between gap-3 rounded-control bg-sunken px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink tabular-nums">{istYear(y.year)}</p>
                    <p className="text-xs text-ink-muted">
                      {y.count} donation{Number(y.count) === 1 ? "" : "s"}
                    </p>
                  </div>
                  <MoneyCell value={y.total} />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon="rupee" title="No donations yet" message="Nothing has been recorded against this donor." />
          )}
        </Card>
      </div>

      {/* The four record lists are tabbed rather than stacked. Everything a
          member of staff needs before picking up the phone - who this is, what
          they have given, when they last gave, and any warning about the name
          or a failed push - stays above the tabs, so the only thing a tab hides
          is the detail of a list whose size is already on its label. Stacked,
          those four lists ran to four screens of scrolling and the notes nobody
          could find were at the bottom. */}
      <Tabs
        className="mb-4"
        value={tab}
        onChange={setTab}
        items={TABS.map((t) => ({
          ...t,
          count: {
            donations: donations.length,
            subscriptions: subscriptions.length,
            prasadam: prasadam_deliveries.length,
            notes: notes.length,
          }[t.key],
        }))}
      />

      {tab === "donations" && (
        <TableShell>
          <Thead>
            <Th align="right">Amount</Th>
            <Th>Purpose</Th>
            <Th>Type</Th>
            <Th>Date</Th>
            <Th>Receipt</Th>
            <Th align="right">Action</Th>
          </Thead>
          {donations.length ? (
            <Tbody>
              {donations.map((d) => (
                <tr key={d.id}>
                  <Td align="right">
                    <MoneyCell value={d.amount} />
                  </Td>
                  <Td className="capitalize">{d.purpose.replace("_", " ")}</Td>
                  <Td className="capitalize">{d.type.replace("-", " ")}</Td>
                  <Td className="text-ink-muted">{shortDate(d.created_at)}</Td>
                  <Td>
                    {d.receipt_generated ? (
                      d.external_ref ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          icon="download"
                          onClick={() => downloadReceiptFile(d.id, d.receipt_number)}
                        >
                          {d.receipt_number || "Download PDF"}
                        </Button>
                      ) : d.receipt_url ? (
                        <a
                          href={d.receipt_url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {d.receipt_number || "View"}
                        </a>
                      ) : (
                        <Badge tone="good">{d.receipt_number || "issued"}</Badge>
                      )
                    ) : (
                      <Badge tone="neutral">not issued</Badge>
                    )}
                  </Td>
                  <Td align="right" className="whitespace-nowrap">
                    {!d.receipt_generated && !d.external_ref && (
                      <Button size="xs" variant="secondary" onClick={() => setShowReceiptFor(d)}>
                        Issue receipt
                      </Button>
                    )}
                    {d.receipt_generated && d.external_ref && (
                      <Button
                        size="xs"
                        variant="whatsapp"
                        icon="message"
                        loading={resendingId === d.id}
                        onClick={() => resendReceipt(d.id)}
                      >
                        Resend on WhatsApp
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Tbody>
          ) : (
            <Tbody hoverable={false}>
              <tr>
                <Td colSpan={6}>
                  <EmptyState
                    icon="rupee"
                    title="No donations yet"
                    message="Nothing has come through from the sites, and nothing has been entered by hand."
                  />
                </Td>
              </tr>
            </Tbody>
          )}
        </TableShell>
      )}

      {tab === "subscriptions" && (
        <>
          <div className="mb-3 flex items-center justify-end">
            <Button size="sm" icon="plus" onClick={() => setShowNewSubscription(true)}>
              New subscription
            </Button>
          </div>
          <TableShell>
            <Thead>
              <Th align="right">Amount</Th>
              <Th>Frequency</Th>
              <Th>Purpose</Th>
              <Th>Next charge</Th>
              <Th>Status</Th>
              <Th align="right">Actions</Th>
            </Thead>
            {subscriptions.length ? (
              <Tbody>
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <Td align="right">
                      <MoneyCell value={s.amount} />
                    </Td>
                    <Td className="capitalize">{s.frequency}</Td>
                    <Td className="capitalize">{s.purpose.replace("_", " ")}</Td>
                    <Td className="text-ink-muted">{shortDate(s.next_charge_date)}</Td>
                    <Td>
                      <StatusBadge status={s.status} />
                    </Td>
                    <Td align="right">
                      <div className="flex items-center justify-end gap-2">
                        {s.status === "active" && (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => updateSubscriptionStatus(s.id, "paused")}
                          >
                            Pause
                          </Button>
                        )}
                        {s.status === "paused" && (
                          <Button
                            size="xs"
                            variant="secondary"
                            onClick={() => updateSubscriptionStatus(s.id, "active")}
                          >
                            Resume
                          </Button>
                        )}
                        {s.status !== "cancelled" && (
                          <Button
                            size="xs"
                            variant="dangerSoft"
                            onClick={() => updateSubscriptionStatus(s.id, "cancelled")}
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </Tbody>
            ) : (
              <Tbody hoverable={false}>
                <tr>
                  <Td colSpan={6}>
                    {/* No action on this one: "New subscription" is already a
                        few pixels above, and two identical buttons that close
                        together read as two different things. */}
                    <EmptyState
                      icon="refresh"
                      title="No recurring donations"
                      message="This donor has no standing instruction set up."
                    />
                  </Td>
                </tr>
              </Tbody>
            )}
          </TableShell>
        </>
      )}

      {tab === "prasadam" && (
        <>
          <div className="mb-3 flex items-center justify-end">
            <Button size="sm" icon="plus" onClick={() => setShowNewDelivery(true)}>
              Queue delivery
            </Button>
          </div>
          <TableShell>
            <Thead>
              <Th>Address</Th>
              <Th>Courier</Th>
              <Th>Tracking</Th>
              <Th>Status</Th>
              <Th align="right">Action</Th>
            </Thead>
            {prasadam_deliveries.length ? (
              <Tbody>
                {prasadam_deliveries.map((d) => (
                  <tr key={d.id}>
                    <Td className="max-w-xs truncate">
                      <span title={d.address}>{d.address}</span>
                    </Td>
                    <Td>{d.courier_name || "—"}</Td>
                    <Td>{d.tracking_number || "—"}</Td>
                    <Td>
                      <StatusBadge status={d.status} />
                    </Td>
                    <Td align="right">
                      {d.status !== "delivered" && d.status !== "returned" && (
                        <Button size="xs" variant="secondary" onClick={() => setUpdatingDelivery(d)}>
                          Update
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </Tbody>
            ) : (
              <Tbody hoverable={false}>
                <tr>
                  <Td colSpan={5}>
                    <EmptyState
                      icon="box"
                      title="No prasadam deliveries queued"
                      message="Nothing is on its way to this donor."
                    />
                  </Td>
                </tr>
              </Tbody>
            )}
          </TableShell>
        </>
      )}

      {tab === "notes" && (
        <Card>
          <CardHeader title="Staff notes" icon="fileText" />
          <form onSubmit={addNote} className="mb-4 flex gap-2">
            <Input
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder='e.g. "Called about missing receipt, resent via WhatsApp"'
              className="flex-1"
            />
            <Button type="submit" icon="plus" loading={savingNote} disabled={!noteText.trim()}>
              Add note
            </Button>
          </form>
          {notes.length ? (
            <div className="space-y-3">
              {notes.map((n) => (
                <div key={n.id} className="border-b border-line-soft pb-3 last:border-0 last:pb-0">
                  <p className="text-sm text-ink">{n.note}</p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {n.author_name || "Staff"} · {dateTime(n.created_at)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon="fileText"
              title="No notes yet"
              message="Anything staff should know before the next call goes here."
            />
          )}
        </Card>
      )}

      {showEdit && (
        <EditProfileModal person={person} onClose={() => setShowEdit(false)} onSaved={load} />
      )}
      {showReceiptFor && (
        <IssueReceiptModal donation={showReceiptFor} onClose={() => setShowReceiptFor(null)} onSaved={load} />
      )}
      {showNewSubscription && (
        <NewSubscriptionModal personId={id} onClose={() => setShowNewSubscription(false)} onSaved={load} />
      )}
      {showNewDelivery && (
        <NewDeliveryModal personId={id} onClose={() => setShowNewDelivery(false)} onSaved={load} />
      )}
      {updatingDelivery && (
        <UpdateDeliveryModal delivery={updatingDelivery} onClose={() => setUpdatingDelivery(null)} onSaved={load} />
      )}
    </div>
  );
}

/**
 * What the page looks like while the profile is in flight.
 *
 * It used to be the single line "Loading donor profile...", which gives no clue
 * how much is coming and makes the whole screen jump into place at once. These
 * blocks sit where the real content will, so nothing moves when it arrives.
 */
function ProfileSkeleton() {
  return (
    <div>
      <div className="mb-6 border-b border-line-soft pb-5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-2 h-7 w-64" />
        <Skeleton className="mt-2 h-4 w-80" />
      </div>
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatTile label="Lifetime giving" value="" icon="rupee" accent="brand" loading />
        <StatTile label="Donations" value="" icon="receipt" loading />
        <StatTile label="Last donation" value="" icon="calendar" loading />
      </div>
      <Card className="mb-5">
        <Skeleton className="h-4 w-32" />
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}>
              <Skeleton className="h-3 w-20" />
              <Skeleton className="mt-1.5 h-4 w-32" />
            </div>
          ))}
        </div>
      </Card>
      <TableShell>
        <Thead>
          <Th align="right">Amount</Th>
          <Th>Purpose</Th>
          <Th>Type</Th>
          <Th>Date</Th>
          <Th>Receipt</Th>
          <Th align="right">Action</Th>
        </Thead>
        <SkeletonRows rows={6} cols={6} />
      </TableShell>
    </div>
  );
}

/**
 * Editing a donor.
 *
 * WHAT WAS WRONG WITH THE OLD ONE
 *   - Save did nothing. It posted whatever the form held, and a blank date
 *     field posts "" - which Postgres cannot cast to DATE, so the request
 *     500'd. There was no try/catch, so the dialog simply sat there and the
 *     donor was never saved. That is now fixed on both sides: the server
 *     reads "" as "not given", and this shows what went wrong when something
 *     does.
 *   - Two unlabelled date boxes. They were date of birth and anniversary, but
 *     nothing on screen said so, so nobody could know which was which.
 *   - One address box, where both sites hold eight fields. A receipt printed
 *     from DRM had nothing to lay out.
 */
function EditProfileModal({ person, onClose, onSaved }: { person: Person; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: person.name,
    phone: person.phone,
    email: person.email || "",
    pan: person.pan || "",
    date_of_birth: person.date_of_birth?.slice(0, 10) || "",
    anniversary_date: person.anniversary_date?.slice(0, 10) || "",
  });
  const [home, setHome] = useState<AddressParts>(() => readParts(person, "address"));
  const [prasadam, setPrasadam] = useState<AddressParts>(() => readParts(person, "prasadam"));
  // Kept and sent back untouched. It holds whatever arrived before DRM had
  // parts, and throwing it away on the first save would lose addresses nobody
  // has got round to splitting yet.
  const [legacy] = useState(person.address || "");
  const [legacyPrasadam] = useState(person.prasadam_address || "");
  const [samePrasadam, setSamePrasadam] = useState(!hasParts(readParts(person, "prasadam")));
  const [roles, setRoles] = useState<string[]>(person.roles);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roleOptions = ["donor", "volunteer", "folk", "congregation"];
  const formId = "edit-donor-profile";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await apiClient.put(`/api/people/${person.id}`, {
        ...form,
        address: legacy,
        prasadam_address: legacyPrasadam,
        address_parts: home,
        prasadam_parts: samePrasadam ? emptyAddress() : prasadam,
        roles,
      });
      onSaved();
      onClose();
    } catch (err) {
      // Shown, not swallowed. The server's wording is the useful one - it
      // names the field, and a message like "A PAN looks like ABCDE1234F" is
      // worth more than "could not save".
      setError(err instanceof Error ? err.message : "Could not save that");
      setSaving(false);
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts: { type?: string; placeholder?: string; wide?: boolean; hint?: string; idPrefix?: string } = {}
  ) => {
    // The two address grids carry the same labels, so the id has to be scoped
    // to the grid - otherwise "City" appears twice on the page with the same
    // id and the second label points a click at the first box.
    const id = `${opts.idPrefix ?? "person"}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    return (
      <Field
        key={id}
        label={label}
        htmlFor={id}
        hint={opts.hint}
        className={opts.wide ? "sm:col-span-2" : ""}
      >
        <Input
          id={id}
          type={opts.type ?? "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={opts.placeholder}
        />
      </Field>
    );
  };

  const addressGrid = (a: AddressParts, set: (v: AddressParts) => void, idPrefix: string) => (
    <div className="grid gap-3 sm:grid-cols-2">
      {field("Door / flat no.", a.door, (v) => set({ ...a, door: v }), { placeholder: "e.g. 12-3-45", idPrefix })}
      {field("Building or house name", a.house, (v) => set({ ...a, house: v }), { idPrefix })}
      {field("Street", a.street, (v) => set({ ...a, street: v }), { wide: true, idPrefix })}
      {field("Area or locality", a.area, (v) => set({ ...a, area: v }), { wide: true, idPrefix })}
      {field("City", a.city, (v) => set({ ...a, city: v }), { placeholder: "Visakhapatnam", idPrefix })}
      {field("State", a.state, (v) => set({ ...a, state: v }), { placeholder: "Andhra Pradesh", idPrefix })}
      {field("Pincode", a.pincode, (v) => set({ ...a, pincode: v.replace(/\D/g, "").slice(0, 6) }), {
        placeholder: "530017",
        idPrefix,
      })}
      {field("Country", a.country, (v) => set({ ...a, country: v }), { idPrefix })}
    </div>
  );

  return (
    <Modal
      title="Edit profile"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {/* Blocked while saving: the old form let a second click fire a
              second request, and a slow network turned one edit into two. */}
          <Button type="submit" form={formId} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}

        {person.name_alt && (
          <Alert tone="warn">
            {person.name_alt_source === "annadan" ? "annadan" : "The site"} calls them{" "}
            <strong>{person.name_alt}</strong>. Saving here settles it and sends your spelling to both sites.
          </Alert>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {field("Full name", form.name, (v) => setForm({ ...form, name: v }), { wide: true })}
          {field("Phone", form.phone, (v) => setForm({ ...form, phone: v }), {
            hint: "The number everything is matched on, here and on both sites.",
          })}
          {field("Email", form.email, (v) => setForm({ ...form, email: v }), { type: "email" })}
          {field("PAN", form.pan, (v) => setForm({ ...form, pan: v.toUpperCase() }), {
            placeholder: "ABCDE1234F",
            hint: "Needed for an 80G certificate.",
          })}
          {field("Date of birth", form.date_of_birth, (v) => setForm({ ...form, date_of_birth: v }), {
            type: "date",
          })}
          {field("Wedding anniversary", form.anniversary_date, (v) => setForm({ ...form, anniversary_date: v }), {
            type: "date",
            hint: "Both are optional, and are what the greeting reminders use.",
          })}
        </div>

        <div className="pt-2">
          <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Address</p>
          {addressGrid(home, setHome, "home")}
          {legacy && !hasParts(home) && (
            <Alert tone="info" className="mt-2 mb-0">
              Currently on file as one line: &ldquo;{legacy}&rdquo;. Split it into the boxes above and the receipts
              will lay it out properly.
            </Alert>
          )}
        </div>

        <div className="pt-2">
          <Checkbox
            checked={samePrasadam}
            onChange={setSamePrasadam}
            label="Send prasadam to the same address"
          />
          {!samePrasadam && (
            <div className="mt-3">
              <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted">
                Prasadam delivery address
              </p>
              {addressGrid(prasadam, setPrasadam, "prasadam")}
            </div>
          )}
        </div>

        <div className="pt-2">
          <p className="mb-2 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Roles</p>
          {/* Tick boxes rather than chips that fill in when chosen. A donor can
              hold several of these at once, and a filled chip is the same
              treatment this product uses for "this is the action to take". */}
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {roleOptions.map((role) => (
              <Checkbox
                key={role}
                checked={roles.includes(role)}
                onChange={(on) => setRoles((prev) => (on ? [...prev, role] : prev.filter((r) => r !== role)))}
                label={titleCase(role)}
              />
            ))}
          </div>
        </div>

        <p className="text-xs text-ink-muted">
          Saving also sends the correction to the donation sites this donor is known to.
        </p>
      </form>
    </Modal>
  );
}

function IssueReceiptModal({ donation, onClose, onSaved }: { donation: Donation; onClose: () => void; onSaved: () => void }) {
  const [receiptNumber, setReceiptNumber] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const formId = "issue-receipt";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.patch(`/api/donations/${donation.id}/receipt`, {
      receipt_number: receiptNumber || undefined,
      receipt_url: receiptUrl || undefined,
    });
    onSaved();
    onClose();
  };

  return (
    <Modal
      title={`Issue receipt — ${currency(donation.amount)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field label="Receipt number" htmlFor="receipt-number">
          <Input
            id="receipt-number"
            value={receiptNumber}
            onChange={(e) => setReceiptNumber(e.target.value)}
          />
        </Field>
        <Field label="Receipt PDF URL" htmlFor="receipt-url" hint="Optional.">
          <Input id="receipt-url" value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} />
        </Field>
        <p className="text-xs text-ink-muted">
          This marks the receipt as issued and queues a WhatsApp notification to the donor.
        </p>
      </form>
    </Modal>
  );
}

function NewSubscriptionModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ amount: "", frequency: "monthly", purpose: "general", next_charge_date: "" });
  const formId = "new-subscription";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.post("/api/subscriptions", {
      person_id: personId,
      amount: Number(form.amount),
      frequency: form.frequency,
      purpose: form.purpose,
      next_charge_date: form.next_charge_date || undefined,
    });
    onSaved();
    onClose();
  };

  return (
    <Modal
      title="New recurring donation"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field label="Amount" htmlFor="subscription-amount" required>
          <Input
            id="subscription-amount"
            type="number"
            step="0.01"
            value={form.amount}
            onChange={(e) => setForm({ ...form, amount: e.target.value })}
            placeholder="₹"
            required
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Frequency">
            <Select
              value={form.frequency}
              onChange={(v) => setForm({ ...form, frequency: v })}
              ariaLabel="Frequency"
              className="w-full"
            >
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </Select>
          </Field>
          <Field label="Purpose">
            <Select
              value={form.purpose}
              onChange={(v) => setForm({ ...form, purpose: v })}
              ariaLabel="Purpose"
              className="w-full"
            >
              <option value="annadan">Annadan</option>
              <option value="temple_maintenance">Temple maintenance</option>
              <option value="festival">Festival</option>
              <option value="general">General</option>
            </Select>
          </Field>
        </div>
        <Field label="Next charge date" htmlFor="subscription-next-charge">
          <Input
            id="subscription-next-charge"
            type="date"
            value={form.next_charge_date}
            onChange={(e) => setForm({ ...form, next_charge_date: e.target.value })}
          />
        </Field>
      </form>
    </Modal>
  );
}

function NewDeliveryModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const formId = "new-delivery";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.post("/api/prasadam", { person_id: personId, address: address || undefined, notes: notes || undefined });
    onSaved();
    onClose();
  };

  return (
    <Modal
      title="Queue prasadam delivery"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field
          label="Delivery address"
          htmlFor="delivery-address"
          hint="Leave blank to use the donor's saved address."
        >
          <Textarea
            id="delivery-address"
            rows={3}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="delivery-notes" hint="Optional.">
          <Input id="delivery-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function UpdateDeliveryModal({ delivery, onClose, onSaved }: { delivery: PrasadamDelivery; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(delivery.status === "pending" ? "packed" : "shipped");
  const [courier, setCourier] = useState(delivery.courier_name || "");
  const [tracking, setTracking] = useState(delivery.tracking_number || "");
  const formId = "update-delivery";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.put(`/api/prasadam/${delivery.id}`, { status, courier_name: courier || undefined, tracking_number: tracking || undefined });
    onSaved();
    onClose();
  };

  return (
    <Modal
      title="Update delivery"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-3">
        <Field label="Status">
          <Select value={status} onChange={(v) => setStatus(v)} ariaLabel="Status" className="w-full">
            <option value="packed">Packed</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="returned">Returned</option>
          </Select>
        </Field>
        <Field label="Courier name" htmlFor="delivery-courier">
          <Input id="delivery-courier" value={courier} onChange={(e) => setCourier(e.target.value)} />
        </Field>
        <Field label="Tracking number" htmlFor="delivery-tracking">
          <Input id="delivery-tracking" value={tracking} onChange={(e) => setTracking(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
