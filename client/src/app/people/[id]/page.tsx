"use client";

import { use, useEffect, useState, FormEvent } from "react";
import Link from "next/link";
import { apiClient } from "@/lib/api";
import { Select } from "@/components/ui";

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

const inr = (n: number) => `₹${Number(n).toLocaleString("en-IN")}`;
const fmtDate = (d?: string) => (d ? new Date(d).toLocaleDateString() : "—");

const badge = (text: string, tone: "brown" | "green" | "amber" | "gray" | "red" = "gray") => {
  const tones: Record<string, string> = {
    brown: "bg-[var(--accent-wash)] text-[var(--accent)]",
    green: "bg-green-50 text-green-700",
    amber: "bg-amber-50 text-amber-700",
    gray: "bg-gray-100 text-gray-600",
    red: "bg-red-50 text-red-700",
  };
  return <span className={`px-2 py-0.5 rounded-full text-xs capitalize ${tones[tone]}`}>{text}</span>;
};

const subscriptionTone = (status: string) => (status === "active" ? "green" : status === "paused" ? "amber" : "red");
const deliveryTone = (status: string) =>
  status === "delivered" ? "green" : status === "shipped" ? "brown" : status === "returned" ? "red" : "amber";

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
  const [syncMessage, setSyncMessage] = useState("");

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
    setSyncMessage("");
    try {
      const result = await apiClient.post<{ donationsSynced: number; subscriptionsSynced: number; deliveriesSynced: number }>(
        `/api/people/${id}/sync-hkmv`,
        {}
      );
      setSyncMessage(
        `Synced ${result.donationsSynced} donation${result.donationsSynced === 1 ? "" : "s"}, ${result.subscriptionsSynced} subscription${result.subscriptionsSynced === 1 ? "" : "s"}, ${result.deliveriesSynced} prasadam ${result.deliveriesSynced === 1 ? "delivery" : "deliveries"} from hkmsite2.0.`
      );
      load();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
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

  if (loading) return <p className="text-gray-500">Loading donor profile...</p>;
  if (notFound || !profile) return <p className="text-red-600">Person not found.</p>;

  const { person, donations, subscriptions, prasadam_deliveries, notes, lifetime } = profile;

  return (
    <div className="space-y-6">
      <Link href="/people" className="text-sm text-gray-500 hover:text-gray-700">
        ← Back to People
      </Link>

      {/* Header / profile card */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{person.name}</h1>
            <p className="text-gray-500 mt-1">{person.phone}{person.email ? ` · ${person.email}` : ""}</p>
            <div className="flex gap-1 mt-3 flex-wrap">
              {person.roles.map((r) => <span key={r}>{badge(r, "brown")}</span>)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={syncFromHkmv}
              disabled={syncing}
              className="px-4 py-2 border border-[var(--accent)] text-[var(--accent)] rounded-lg text-sm hover:bg-[var(--accent-wash)] disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "Sync from HKMV"}
            </button>
            <button
              onClick={() => setShowEdit(true)}
              className="px-4 py-2 border border-slate-300 rounded-lg text-sm hover:bg-gray-50"
            >
              Edit Profile
            </button>
          </div>
        </div>
        {syncMessage && <p className="text-sm text-gray-500 mt-3">{syncMessage}</p>}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6 text-sm">
          <div>
            <p className="text-gray-500">PAN</p>
            <p className="font-medium">{person.pan || "—"}</p>
          </div>
          <div>
            <p className="text-gray-500">Date of birth</p>
            <p className="font-medium">{fmtDate(person.date_of_birth)}</p>
          </div>
          <div>
            <p className="text-gray-500">Anniversary</p>
            <p className="font-medium">{fmtDate(person.anniversary_date)}</p>
          </div>
        </div>

        <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
          <div>
            <p className="text-gray-500">Address</p>
            {(() => {
              const lines = addressLines(readParts(person, "address"), person.address);
              return lines.length ? (
                <div className="font-medium leading-snug">
                  {lines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </div>
              ) : (
                <p className="font-medium text-slate-400">Not set</p>
              );
            })()}
          </div>
          <div>
            <p className="text-gray-500">Prasadam delivery address</p>
            {(() => {
              const own = readParts(person, "prasadam");
              const lines = hasParts(own)
                ? addressLines(own, person.prasadam_address)
                : addressLines(readParts(person, "address"), person.prasadam_address || person.address);
              const sameAsHome = !hasParts(own) && !person.prasadam_address;
              return lines.length ? (
                <div className="font-medium leading-snug">
                  {lines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                  {sameAsHome && <p className="mt-0.5 text-xs text-slate-400">Same as their address</p>}
                </div>
              ) : (
                <p className="font-medium text-slate-400">Not set</p>
              );
            })()}
          </div>
        </div>

        {/* The sites disagree about this donor's name. Worth showing on the
            record rather than only in the edit form: somebody reading the page
            should know the spelling is contested before they read it out on a
            call. */}
        {person.name_alt && (
          <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <strong>{person.name_alt_source === "annadan" ? "annadan" : "The donation site"}</strong> has this donor
            as <strong>{person.name_alt}</strong>. Open Edit profile to settle which spelling is right — it will be
            sent to both sites.
          </div>
        )}

        {person.push_status === "failed" || person.push_status === "partial" ? (
          <div className="mt-3 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">
            The last change here did not reach {person.push_status === "partial" ? "every site" : "the sites"}.
            {person.push_error && <span className="block text-xs mt-0.5">{person.push_error}</span>}
          </div>
        ) : null}
      </div>

      {resendNote && (
        <div
          className={`rounded-lg px-4 py-3 text-sm border ${
            resendNote.tone === "ok"
              ? "bg-emerald-50 text-emerald-800 border-emerald-200"
              : "bg-red-50 text-red-700 border-red-200"
          }`}
        >
          {resendNote.text}
        </div>
      )}

      {/* Total donated */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-gray-900">Total Donated</h2>
          <p className="text-2xl font-bold text-[var(--accent)]">{inr(lifetime.total)}</p>
        </div>
        <div className="flex gap-4 flex-wrap">
          {lifetime.by_year.map((y) => (
            <div key={y.year} className="px-4 py-2 bg-gray-50 rounded-lg">
              <p className="text-xs text-gray-500">{new Date(y.year).getFullYear()}</p>
              <p className="font-semibold text-gray-900">{inr(y.total)}</p>
              <p className="text-xs text-gray-400">{y.count} donation{Number(y.count) === 1 ? "" : "s"}</p>
            </div>
          ))}
          {lifetime.by_year.length === 0 && <p className="text-gray-500 text-sm">No donations yet.</p>}
        </div>
      </div>

      {/* Donations & receipts */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Donations &amp; Receipts</h2>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Amount</th>
              <th className="px-6 py-3 font-medium">Purpose</th>
              <th className="px-6 py-3 font-medium">Type</th>
              <th className="px-6 py-3 font-medium">Date</th>
              <th className="px-6 py-3 font-medium">Receipt</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {donations.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-semibold">{inr(d.amount)}</td>
                <td className="px-6 py-3 capitalize">{d.purpose.replace("_", " ")}</td>
                <td className="px-6 py-3 capitalize">{d.type.replace("-", " ")}</td>
                <td className="px-6 py-3 text-gray-500">{fmtDate(d.created_at)}</td>
                <td className="px-6 py-3">
                  {d.receipt_generated ? (
                    d.external_ref ? (
                      <button
                        onClick={() => downloadReceiptFile(d.id, d.receipt_number)}
                        className="text-[var(--accent)] hover:underline"
                      >
                        {d.receipt_number || "Download PDF"}
                      </button>
                    ) : d.receipt_url ? (
                      <a href={d.receipt_url} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                        {d.receipt_number || "View"}
                      </a>
                    ) : (
                      badge(d.receipt_number || "issued", "green")
                    )
                  ) : (
                    badge("not issued", "gray")
                  )}
                </td>
                <td className="px-6 py-3 text-right whitespace-nowrap">
                  {!d.receipt_generated && !d.external_ref && (
                    <button
                      onClick={() => setShowReceiptFor(d)}
                      className="text-[var(--accent)] text-sm font-medium hover:underline"
                    >
                      Issue receipt
                    </button>
                  )}
                  {d.receipt_generated && d.external_ref && (
                    <button
                      onClick={() => resendReceipt(d.id)}
                      disabled={resendingId === d.id}
                      className="text-[var(--accent)] text-sm font-medium hover:underline disabled:opacity-50"
                    >
                      {resendingId === d.id ? "Sending…" : "Resend on WhatsApp"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {donations.length === 0 && <div className="p-8 text-center text-gray-500">No donations yet</div>}
      </div>

      {/* Subscriptions */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Recurring Donations</h2>
          <button
            onClick={() => setShowNewSubscription(true)}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg text-sm font-medium"
          >
            + New Subscription
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Amount</th>
              <th className="px-6 py-3 font-medium">Frequency</th>
              <th className="px-6 py-3 font-medium">Purpose</th>
              <th className="px-6 py-3 font-medium">Next charge</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {subscriptions.map((s) => (
              <tr key={s.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 font-semibold">{inr(s.amount)}</td>
                <td className="px-6 py-3 capitalize">{s.frequency}</td>
                <td className="px-6 py-3 capitalize">{s.purpose.replace("_", " ")}</td>
                <td className="px-6 py-3 text-gray-500">{fmtDate(s.next_charge_date)}</td>
                <td className="px-6 py-3">{badge(s.status, subscriptionTone(s.status) as "green" | "amber" | "red")}</td>
                <td className="px-6 py-3 text-right space-x-3">
                  {s.status === "active" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "paused")} className="text-sm text-amber-700 hover:underline">
                      Pause
                    </button>
                  )}
                  {s.status === "paused" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "active")} className="text-sm text-green-700 hover:underline">
                      Resume
                    </button>
                  )}
                  {s.status !== "cancelled" && (
                    <button onClick={() => updateSubscriptionStatus(s.id, "cancelled")} className="text-sm text-red-600 hover:underline">
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {subscriptions.length === 0 && <div className="p-8 text-center text-gray-500">No recurring donations</div>}
      </div>

      {/* Prasadam deliveries */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-100">
          <h2 className="text-lg font-semibold text-gray-900">Prasadam Deliveries</h2>
          <button
            onClick={() => setShowNewDelivery(true)}
            className="bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white px-3 py-1.5 rounded-lg text-sm font-medium"
          >
            + Queue Delivery
          </button>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-6 py-3 font-medium">Address</th>
              <th className="px-6 py-3 font-medium">Courier</th>
              <th className="px-6 py-3 font-medium">Tracking</th>
              <th className="px-6 py-3 font-medium">Status</th>
              <th className="px-6 py-3 font-medium"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {prasadam_deliveries.map((d) => (
              <tr key={d.id} className="hover:bg-gray-50">
                <td className="px-6 py-3 max-w-xs truncate" title={d.address}>{d.address}</td>
                <td className="px-6 py-3">{d.courier_name || "—"}</td>
                <td className="px-6 py-3">{d.tracking_number || "—"}</td>
                <td className="px-6 py-3">{badge(d.status, deliveryTone(d.status) as "green" | "amber" | "red" | "brown")}</td>
                <td className="px-6 py-3 text-right">
                  {d.status !== "delivered" && d.status !== "returned" && (
                    <button onClick={() => setUpdatingDelivery(d)} className="text-[var(--accent)] text-sm font-medium hover:underline">
                      Update
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {prasadam_deliveries.length === 0 && <div className="p-8 text-center text-gray-500">No prasadam deliveries queued</div>}
      </div>

      {/* Staff notes */}
      <div className="bg-white rounded-xl shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">Staff Notes</h2>
        <form onSubmit={addNote} className="flex gap-3 mb-4">
          <input
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder='e.g. "Called about missing receipt, resent via WhatsApp"'
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
          />
          <button
            type="submit"
            disabled={savingNote || !noteText.trim()}
            className="px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium disabled:opacity-50"
          >
            Add Note
          </button>
        </form>
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.id} className="border-b border-gray-100 pb-3 last:border-0">
              <p className="text-gray-900">{n.note}</p>
              <p className="text-xs text-gray-400 mt-1">
                {n.author_name || "Staff"} · {new Date(n.created_at).toLocaleString()}
              </p>
            </div>
          ))}
          {notes.length === 0 && <p className="text-gray-500 text-sm">No notes yet.</p>}
        </div>
      </div>

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

function ModalShell({ title, children, onClose, onSubmit, busy = false, wide = false }: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  busy?: boolean;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4">
      <form
        onSubmit={onSubmit}
        className={`my-8 w-full ${wide ? "max-w-3xl" : "max-w-xl"} space-y-4 rounded-2xl bg-white p-8`}
      >
        <h2 className="text-xl font-bold">{title}</h2>
        {children}
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          {/* Disabled while saving: the old form let a second click fire a
              second request, and a slow network turned one edit into two. */}
          <button
            type="submit"
            disabled={busy}
            className="flex-1 rounded-lg bg-[var(--accent)] px-4 py-2.5 text-white hover:bg-[var(--accent-hover)] disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </div>
  );
}

const inputClass = "w-full px-4 py-2.5 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--accent)]";

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
    opts: { type?: string; placeholder?: string; wide?: boolean; hint?: string } = {}
  ) => (
    <label className={`block text-xs text-slate-500 ${opts.wide ? "sm:col-span-2" : ""}`}>
      {label}
      <input
        type={opts.type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts.placeholder}
        className={`${inputClass} mt-1`}
      />
      {opts.hint && <span className="mt-0.5 block text-[11px] text-slate-400">{opts.hint}</span>}
    </label>
  );

  const addressGrid = (a: AddressParts, set: (v: AddressParts) => void, idPrefix: string) => (
    <div key={idPrefix} className="grid gap-3 sm:grid-cols-2">
      {field("Door / flat no.", a.door, (v) => set({ ...a, door: v }), { placeholder: "e.g. 12-3-45" })}
      {field("Building or house name", a.house, (v) => set({ ...a, house: v }))}
      {field("Street", a.street, (v) => set({ ...a, street: v }), { wide: true })}
      {field("Area or locality", a.area, (v) => set({ ...a, area: v }), { wide: true })}
      {field("City", a.city, (v) => set({ ...a, city: v }), { placeholder: "Visakhapatnam" })}
      {field("State", a.state, (v) => set({ ...a, state: v }), { placeholder: "Andhra Pradesh" })}
      {field("Pincode", a.pincode, (v) => set({ ...a, pincode: v.replace(/\D/g, "").slice(0, 6) }), {
        placeholder: "530017",
      })}
      {field("Country", a.country, (v) => set({ ...a, country: v }))}
    </div>
  );

  return (
    <ModalShell title="Edit profile" onClose={onClose} onSubmit={submit} busy={saving}>
      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {person.name_alt && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {person.name_alt_source === "annadan" ? "annadan" : "The site"} calls them{" "}
          <strong>{person.name_alt}</strong>. Saving here settles it and sends your spelling to both sites.
        </p>
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
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Address</p>
        {addressGrid(home, setHome, "home")}
        {legacy && !hasParts(home) && (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Currently on file as one line: &ldquo;{legacy}&rdquo;. Split it into the boxes above and the receipts
            will lay it out properly.
          </p>
        )}
      </div>

      <div className="pt-2">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={samePrasadam}
            onChange={(e) => setSamePrasadam(e.target.checked)}
            className="rounded border-slate-300"
          />
          Send prasadam to the same address
        </label>
        {!samePrasadam && (
          <div className="mt-3">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              Prasadam delivery address
            </p>
            {addressGrid(prasadam, setPrasadam, "prasadam")}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        {roleOptions.map((role) => (
          <button
            key={role}
            type="button"
            onClick={() => setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]))}
            className={`rounded-full px-3 py-1.5 text-sm capitalize ${
              roles.includes(role) ? "bg-[var(--accent)] text-white" : "bg-slate-100 text-slate-700"
            }`}
          >
            {role}
          </button>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        Saving also sends the correction to the donation sites this donor is known to.
      </p>
    </ModalShell>
  );
}

function IssueReceiptModal({ donation, onClose, onSaved }: { donation: Donation; onClose: () => void; onSaved: () => void }) {
  const [receiptNumber, setReceiptNumber] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");

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
    <ModalShell title={`Issue Receipt — ${inr(donation.amount)}`} onClose={onClose} onSubmit={submit}>
      <input value={receiptNumber} onChange={(e) => setReceiptNumber(e.target.value)} placeholder="Receipt number" className={inputClass} />
      <input value={receiptUrl} onChange={(e) => setReceiptUrl(e.target.value)} placeholder="Receipt PDF URL (optional)" className={inputClass} />
      <p className="text-xs text-gray-500">This marks the receipt as issued and queues a WhatsApp notification to the donor.</p>
    </ModalShell>
  );
}

function NewSubscriptionModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ amount: "", frequency: "monthly", purpose: "general", next_charge_date: "" });

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
    <ModalShell title="New Recurring Donation" onClose={onClose} onSubmit={submit}>
      <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="Amount (₹) *" required className={inputClass} />
      <div className="grid grid-cols-2 gap-3">
        <Select value={form.frequency} onChange={(v) => setForm({ ...form, frequency: v })} className="w-full">
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
          <option value="yearly">Yearly</option>
        </Select>
        <Select value={form.purpose} onChange={(v) => setForm({ ...form, purpose: v })} className="w-full">
          <option value="annadan">Annadan</option>
          <option value="temple_maintenance">Temple maintenance</option>
          <option value="festival">Festival</option>
          <option value="general">General</option>
        </Select>
      </div>
      <input type="date" value={form.next_charge_date} onChange={(e) => setForm({ ...form, next_charge_date: e.target.value })} className={inputClass} />
    </ModalShell>
  );
}

function NewDeliveryModal({ personId, onClose, onSaved }: { personId: string; onClose: () => void; onSaved: () => void }) {
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.post("/api/prasadam", { person_id: personId, address: address || undefined, notes: notes || undefined });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="Queue Prasadam Delivery" onClose={onClose} onSubmit={submit}>
      <textarea
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        placeholder="Delivery address (leave blank to use the donor's saved address)"
        className={inputClass}
        rows={3}
      />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes (optional)" className={inputClass} />
    </ModalShell>
  );
}

function UpdateDeliveryModal({ delivery, onClose, onSaved }: { delivery: PrasadamDelivery; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState(delivery.status === "pending" ? "packed" : "shipped");
  const [courier, setCourier] = useState(delivery.courier_name || "");
  const [tracking, setTracking] = useState(delivery.tracking_number || "");

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await apiClient.put(`/api/prasadam/${delivery.id}`, { status, courier_name: courier || undefined, tracking_number: tracking || undefined });
    onSaved();
    onClose();
  };

  return (
    <ModalShell title="Update Delivery" onClose={onClose} onSubmit={submit}>
      <Select value={status} onChange={(v) => setStatus(v)} className="w-full">
        <option value="packed">Packed</option>
        <option value="shipped">Shipped</option>
        <option value="delivered">Delivered</option>
        <option value="returned">Returned</option>
      </Select>
      <input value={courier} onChange={(e) => setCourier(e.target.value)} placeholder="Courier name" className={inputClass} />
      <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="Tracking number" className={inputClass} />
    </ModalShell>
  );
}
