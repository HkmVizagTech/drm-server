"use client";

// The seva wall: the names that go on the temple's bricks, and each brick's
// journey from "to print" to "sent to the donor". One table component, three
// views, because the people using it do different jobs:
//
//   contact  "Seva wall"        bricks whose picture is uploaded. A caller (Manas)
//                               calls the donor, sends the picture on WhatsApp and
//                               records both - or sends a bad picture back.
//   print    "Bricks to print"  what still has to be printed or reprinted. The
//                               brick printer sees ONLY this, read-only, and
//                               uploads the picture; the row then leaves this table
//                               and lands on the Seva wall.
//   all      "All records"      everything, for the admin to oversee.
//
// Who may do what is decided by the server; what is shown here only mirrors it,
// so a button that would be refused is simply not drawn.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient, isAbort } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { currency, number, shortDate } from "@/lib/format";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Select,
  SkeletonRows,
  TableShell,
  Tabs,
  Tbody,
  Td,
  Textarea,
  Th,
  Thead,
} from "@/components/ui";
import { Icon } from "@/components/icons";
import { downloadSample, readSpreadsheet, SPREADSHEET_ACCEPT, type ParsedSheet } from "@/lib/spreadsheet";
import { toast } from "@/components/toast";

export type WallView = "contact" | "print" | "all";
type Kind = "brick" | "square" | "mandir";
type Priority = "high" | "medium" | "low";
type Status = "to_print" | "needs_reprint" | "in_review" | "sent";

interface Row {
  ref: string;
  origin?: "donation" | "manual";
  donor_name: string | null;
  honoree_name: string | null;
  phone?: string | null;
  amount?: number;
  receipt_number?: string | null;
  kind: Kind;
  donated_at: string;
  priority: Priority;
  status: Status;
  review_note: string | null;
  reviewed_at?: string | null;
  called_at?: string | null;
  called_by_name?: string | null;
  sent_at?: string | null;
  sent_by_name?: string | null;
  has_image?: boolean;
  uploaded_at?: string | null;
  /** Public link to the picture, when it is stored where a donor can open it. */
  image_url?: string | null;
}

interface Response {
  role: string;
  view: WallView;
  views: WallView[];
  rows: Row[];
  total: number;
  page: number;
  limit: number;
  total_pages: number;
  min_amount: number;
  counts: Partial<Record<"to_print" | "needs_reprint" | "uploaded" | "to_call" | "called" | "sent", number>>;
}

const KIND_LABEL: Record<Kind, string> = {
  brick: "Brick seva",
  square: "Square foot seva",
  mandir: "Mandir nirmana seva",
};
const PRIORITY_TONE: Record<Priority, "danger" | "warn" | "neutral"> = { high: "danger", medium: "warn", low: "neutral" };
const MAX_BYTES = 5 * 1024 * 1024;

const VIEW_HREF: Record<WallView, string> = { contact: "/seva-wall", print: "/seva-wall/print", all: "/seva-wall/all" };

/** The tables a role may open, first one being where it belongs. The server enforces the same. */
function viewsFor(role: string): WallView[] {
  if (role === "brick_printer") return ["print"];
  if (role === "caller") return ["contact"];
  return ["contact", "print", "all"];
}

const TITLES: Record<WallView, { title: string; subtitle: string }> = {
  contact: {
    title: "Seva wall",
    subtitle:
      "Bricks whose picture is ready. Call the donor, send the picture on WhatsApp, and record each step. Pictures nobody has acted on come first, then donors already called.",
  },
  print: {
    title: "Bricks to print",
    subtitle:
      "Print the name on the brick, then upload its picture to check it. Bricks sent back for a reprint come first, then the most urgent, then the oldest. Not happy with a picture? Replace it until a caller starts on it.",
  },
  all: {
    title: "All records",
    subtitle: "Every donor of Mandir nirmana, Brick and Square foot seva who gave Rs 1,500 or more, at every stage.",
  },
};

/* ----------------------------------------------------------------- helpers */

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Could not read that file."));
    r.readAsDataURL(file);
  });
}

/**
 * The name that goes ON the brick. When the donor gave in someone else's name (a
 * parent, a child), that name is printed; otherwise the donor's own.
 */
function printName(r: Row): string {
  return r.honoree_name || r.donor_name || "-";
}

function daysSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function waiting(iso: string): string {
  const d = daysSince(iso);
  return d === 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
}

const WHATSAPP_PATH =
  "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z";

/** The message the caller sees ready to send; they can edit it before pressing send. */
function thanksMessage(r: Row): string {
  const lines = [
    "Hare Krishna,",
    "",
    `Thank you${r.donor_name ? ` ${r.donor_name}` : ""} for your ${KIND_LABEL[r.kind]}.${
      r.honoree_name ? ` It is offered in the name of ${r.honoree_name}.` : ""
    }`,
  ];
  if (r.image_url) lines.push("", "Here is the picture with your name printed:", r.image_url);
  lines.push("", "Hare Krishna!");
  return lines.join("\n");
}

function digitsOf(phone: string | null | undefined): string {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length === 10 ? `91${d}` : d;
}

/** The phone and WhatsApp icons: round, one tap each. */
function ContactIcons({ row }: { row: Row }) {
  const to = digitsOf(row.phone);
  if (to.length < 10) return <span className="text-ink-faint">-</span>;
  const name = row.donor_name ?? "donor";
  const base =
    "inline-grid h-9 w-9 place-items-center rounded-control ring-1 ring-inset ring-line-soft transition-colors";
  return (
    <div className="flex items-center gap-2">
      <a
        href={`tel:+${to}`}
        title={`Call ${name}`}
        aria-label={`Call ${name}`}
        className={`${base} text-brand-700 hover:bg-brand-50`}
      >
        <Icon name="phone" size={16} />
      </a>
      <a
        href={`https://wa.me/${to}?text=${encodeURIComponent(thanksMessage(row))}`}
        target="_blank"
        rel="noreferrer"
        title={`Message ${name} on WhatsApp`}
        aria-label={`Message ${name} on WhatsApp`}
        className={`${base} text-[#25D366] hover:bg-[#25D366]/10`}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
          <path d={WHATSAPP_PATH} />
        </svg>
      </a>
    </div>
  );
}

/** The uploaded picture. Fetched with the login token, which an <img src> cannot carry. */
function Picture({ row }: { row: Row }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    apiClient
      .getBlob(`/api/seva-wall/${row.ref}/image`)
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
    // A new upload for the same brick has a new timestamp: fetch it again.
  }, [row.ref, row.uploaded_at]);

  if (failed) return <span className="text-xs text-ink-muted">Could not load</span>;
  if (!url) return <span className="inline-block h-14 w-14 animate-pulse rounded-control bg-sunken" />;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title="View picture" className="block rounded-control">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="Printed brick" className="h-14 w-14 rounded-control object-cover ring-1 ring-line-soft" />
      </button>
      {open && (
        <Modal title={`${row.donor_name ?? "Brick"} - ${KIND_LABEL[row.kind]}`} onClose={() => setOpen(false)} wide>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Printed brick" className="mx-auto max-h-[70vh] w-auto rounded-control" />
        </Modal>
      )}
    </>
  );
}

function StatusBadge({ row, waitingForReview = false }: { row: Row; waitingForReview?: boolean }) {
  switch (row.status) {
    case "to_print":
      return <Badge tone="neutral" dot>To print</Badge>;
    case "needs_reprint":
      return <Badge tone="danger" dot>Needs reprint</Badge>;
    case "in_review":
      if (waitingForReview) return <Badge tone="info" dot>Waiting for review</Badge>;
      return row.called_at ? (
        <Badge tone="info" dot>Called - picture not sent</Badge>
      ) : (
        <Badge tone="warn" dot>Not called yet</Badge>
      );
    case "sent":
      return <Badge tone="good" dot>Picture sent</Badge>;
  }
}

/* ---------------------------------------------------------------- the page */

export default function WallTable({ view }: { view: WallView }) {
  const { user } = useAuth();
  const router = useRouter();
  const role = user?.role ?? "";
  const allowed = viewsFor(role).includes(view);
  const isAdmin = role === "admin";
  const isPrinter = role === "brick_printer";
  const canContact = role === "admin" || role === "caller";
  const canUpload = role === "admin" || role === "brick_printer";

  const [stage, setStage] = useState("");
  const [kind, setKind] = useState("");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [bulk, setBulk] = useState(false);
  const [sendingBack, setSendingBack] = useState<Row | null>(null);
  // A picture chosen but not yet sent: shown for checking first.
  const [pending, setPending] = useState<{ row: Row; file: File; url: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const target = useRef<string | null>(null);
  const targetRow = useRef<Row | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!role || !allowed) return;
      const qs = new URLSearchParams({ view, page: String(page), limit: "25" });
      if (stage) qs.set("stage", stage);
      if (kind) qs.set("kind", kind);
      if (priority) qs.set("priority", priority);
      if (query) qs.set("search", query);
      try {
        setData(await apiClient.get<Response>(`/api/seva-wall?${qs}`, { signal }));
        setError(null);
      } catch (e) {
        if (isAbort(e)) return;
        setError((e as Error).message);
      }
    },
    [role, allowed, view, stage, kind, priority, query, page]
  );

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  // Somebody opened a table that is not theirs (a printer on the Seva wall, a
  // caller on the print list): take them to their own.
  useEffect(() => {
    if (role && !allowed) router.replace(VIEW_HREF[viewsFor(role)[0]]);
  }, [role, allowed, router]);

  /** Run one action on one row, then refresh the table. */
  async function act(ref: string, path: string, body: unknown, done: string) {
    setBusy(ref);
    try {
      await apiClient.post(`/api/seva-wall/${ref}/${path}`, body ?? {});
      toast.success(done);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setRowPriority(ref: string, value: string) {
    try {
      await apiClient.patch(`/api/seva-wall/${ref}`, { priority: value });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function pickFile(row: Row) {
    target.current = row.ref;
    targetRow.current = row;
    fileRef.current?.click();
  }

  /** A file was chosen: check it, then show it for a look before anything is sent. */
  function onFile(file: File | undefined) {
    const row = targetRow.current;
    if (fileRef.current) fileRef.current.value = "";
    if (!file || !row) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return toast.error("Use a JPG, PNG or WebP picture.");
    if (file.size > MAX_BYTES) return toast.error("That picture is over 5 MB. Use a smaller one.");
    setPending((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return { row, file, url: URL.createObjectURL(file) };
    });
  }

  function closePreview() {
    setPending((p) => {
      if (p) URL.revokeObjectURL(p.url);
      return null;
    });
  }

  async function confirmUpload() {
    if (!pending) return;
    const { row, file } = pending;
    setBusy(row.ref);
    try {
      const r = await apiClient.post<{ replaced?: boolean }>(`/api/seva-wall/${row.ref}/image`, {
        mime: file.type,
        base64: await readBase64(file),
      });
      toast.success(
        r.replaced ? "Picture replaced" : "Picture uploaded",
        r.replaced ? "The old picture was deleted." : "It has moved to the Seva wall for review."
      );
      closePreview();
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!role || !allowed) return null;

  const counts = data?.counts ?? {};
  const { title, subtitle } = TITLES[view];
  const showMoney = !isPrinter; // phone, amount and receipt are not the printer's to see
  const cols = view === "print" ? (isPrinter ? 6 : 8) : view === "contact" ? 10 : 11;

  const stageTabs = [
    { key: "", label: "All", count: (counts.to_call ?? 0) + (counts.called ?? 0) + (counts.sent ?? 0) },
    { key: "to_call", label: "Not called yet", count: counts.to_call ?? 0 },
    { key: "called", label: "Called - not sent", count: counts.called ?? 0 },
    { key: "sent", label: "Picture sent", count: counts.sent ?? 0 },
  ];

  return (
    <div>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" icon="upload" onClick={() => setBulk(true)}>
                Bulk upload
              </Button>
              <Button icon="plus" onClick={() => setAdding(true)}>
                Add record
              </Button>
            </div>
          ) : undefined
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />

      {view === "print" && data && stage === "" && (
        <div className="mb-4 flex flex-wrap gap-2">
          {(counts.needs_reprint ?? 0) > 0 && (
            <Badge tone="danger" dot>
              {number(counts.needs_reprint)} sent back for reprint
            </Badge>
          )}
          <Badge tone="neutral" dot>
            {number(counts.to_print)} new to print
          </Badge>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {view === "contact" && (
          <Tabs
            variant="pill"
            items={stageTabs}
            value={stage}
            onChange={(k) => {
              setStage(k);
              setPage(1);
            }}
          />
        )}
        {view === "print" && (
          <Tabs
            variant="pill"
            items={[
              { key: "", label: "To print", count: (counts.to_print ?? 0) + (counts.needs_reprint ?? 0) },
              { key: "uploaded", label: "Uploaded", count: counts.uploaded ?? 0 },
            ]}
            value={stage}
            onChange={(k) => {
              setStage(k);
              setPage(1);
            }}
          />
        )}
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={isPrinter ? "Search name" : "Search name, phone or receipt"}
          className="w-full sm:w-64"
        />
        <Select
          value={kind}
          onChange={(v) => {
            setKind(v);
            setPage(1);
          }}
          ariaLabel="Seva"
          className="w-48"
        >
          <option value="">All sevas</option>
          <option value="brick">Brick seva</option>
          <option value="square">Square foot seva</option>
          <option value="mandir">Mandir nirmana seva</option>
        </Select>
        {view !== "contact" && (
          <Select
            value={priority}
            onChange={(v) => {
              setPriority(v);
              setPage(1);
            }}
            ariaLabel="Priority"
            className="w-40"
          >
            <option value="">Any priority</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      <TableShell>
        <Thead>
          {view === "contact" && <Th>Picture</Th>}
          {view !== "contact" && <Th>Priority</Th>}
          <Th>{view === "print" ? "Name to print" : "Donor name"}</Th>
          {view !== "print" && <Th>Honoree name</Th>}
          {showMoney && <Th>Phone</Th>}
          {showMoney && <Th align="right">Amount</Th>}
          {showMoney && <Th>Receipt no.</Th>}
          <Th>Seva</Th>
          {view === "print" && isPrinter && <Th>Waiting</Th>}
          {view !== "print" && <Th>Date</Th>}
          <Th>Status</Th>
          {view === "contact" && canContact && <Th>Contact</Th>}
          {view === "contact" && canContact && <Th>Update</Th>}
          {view !== "contact" && canUpload && <Th>{view === "print" ? "Picture" : "Upload"}</Th>}
          {view === "all" && <Th>Picture</Th>}
        </Thead>
        {!data ? (
          <SkeletonRows rows={6} cols={cols} />
        ) : (
          <Tbody>
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={cols}>
                  <EmptyState
                    icon="box"
                    title={
                      view === "print"
                        ? "Nothing to print"
                        : view === "contact"
                        ? "No pictures to follow up"
                        : "Nobody here yet"
                    }
                    message={
                      view === "print"
                        ? "New bricks appear here when a donor gives Rs 1,500 or more."
                        : view === "contact"
                        ? "Bricks appear here once the printer uploads their picture."
                        : "Donations of Rs 1,500 or more to Mandir nirmana, Brick or Square foot seva appear here on their own."
                    }
                  />
                </td>
              </tr>
            ) : (
              data.rows.map((r) => (
                <tr key={r.ref} className={r.status === "needs_reprint" && view === "print" ? "bg-danger/5" : undefined}>
                  {view === "contact" && (
                    <Td>
                      {r.has_image ? <Picture row={r} /> : <span className="text-ink-faint">-</span>}
                    </Td>
                  )}
                  {view !== "contact" && (
                    <Td>
                      {isAdmin ? (
                        <Select
                          value={r.priority}
                          onChange={(v) => void setRowPriority(r.ref, v)}
                          ariaLabel={`Priority for ${r.donor_name ?? "record"}`}
                          className="w-28"
                        >
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </Select>
                      ) : (
                        <Badge tone={PRIORITY_TONE[r.priority]}>
                          {r.priority[0].toUpperCase() + r.priority.slice(1)}
                        </Badge>
                      )}
                    </Td>
                  )}
                  <Td className="font-medium text-ink">
                    {view === "print" ? printName(r) : r.donor_name || "-"}
                    {r.origin === "manual" && (
                      <span className="ml-2 align-middle">
                        <Badge tone="neutral">Added by hand</Badge>
                      </span>
                    )}
                    {/* The honoree is what gets printed, so the donor is the small print. */}
                    {view === "print" && r.honoree_name && r.donor_name && (
                      <span className="mt-0.5 block text-xs font-normal text-ink-muted">Donor: {r.donor_name}</span>
                    )}
                  </Td>
                  {view !== "print" && (
                    <Td>{r.honoree_name || <span className="text-ink-faint">-</span>}</Td>
                  )}
                  {showMoney && <Td className="tabular-nums">{r.phone || "-"}</Td>}
                  {showMoney && (
                    <Td align="right" className="tabular-nums font-medium text-ink">
                      {r.amount != null ? currency(r.amount) : "-"}
                    </Td>
                  )}
                  {showMoney && (
                    <Td className="whitespace-nowrap font-mono text-xs">
                      {r.receipt_number || <span className="text-ink-faint">-</span>}
                    </Td>
                  )}
                  <Td>
                    <Badge tone="brand">{KIND_LABEL[r.kind]}</Badge>
                  </Td>
                  {view === "print" && isPrinter && <Td className="whitespace-nowrap">{waiting(r.donated_at)}</Td>}
                  {view !== "print" && <Td className="whitespace-nowrap">{shortDate(r.donated_at)}</Td>}
                  <Td>
                    <StatusBadge row={r} waitingForReview={isPrinter} />
                    {r.status === "needs_reprint" && r.review_note && (
                      <span className="mt-1 block max-w-xs text-xs text-danger">
                        Sent back: {r.review_note}
                        {r.reviewed_at ? ` (${shortDate(r.reviewed_at)})` : ""}
                      </span>
                    )}
                    {r.status === "in_review" && r.called_at && r.called_by_name && (
                      <span className="mt-1 block text-xs text-ink-muted">Called by {r.called_by_name}</span>
                    )}
                    {r.status === "sent" && (
                      <span className="mt-1 block text-xs text-ink-muted">
                        {r.sent_by_name ? `by ${r.sent_by_name}` : ""}
                        {r.sent_at ? ` ${shortDate(r.sent_at)}` : ""}
                      </span>
                    )}
                  </Td>

                  {view === "contact" && canContact && (
                    <Td>
                      <ContactIcons row={r} />
                    </Td>
                  )}
                  {view === "contact" && canContact && (
                    <Td>
                      {r.status === "in_review" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {!r.called_at && (
                            <Button
                              size="xs"
                              variant="secondary"
                              icon="phone"
                              loading={busy === r.ref}
                              onClick={() => void act(r.ref, "called", {}, "Marked: call answered")}
                            >
                              Call answered
                            </Button>
                          )}
                          <Button
                            size="xs"
                            variant="whatsapp"
                            loading={busy === r.ref}
                            onClick={() => void act(r.ref, "mark-sent", {}, "Marked: picture sent")}
                          >
                            WhatsApp sent
                          </Button>
                          <Button size="xs" variant="ghost" icon="arrowLeft" onClick={() => setSendingBack(r)}>
                            Send back
                          </Button>
                        </div>
                      ) : (
                        <span className="text-ink-faint">Done</span>
                      )}
                    </Td>
                  )}

                  {view !== "contact" && canUpload && (
                    <Td>
                      {r.status === "to_print" || r.status === "needs_reprint" ? (
                        <Button
                          size="sm"
                          variant={r.status === "needs_reprint" ? "primary" : "secondary"}
                          icon="upload"
                          loading={busy === r.ref}
                          onClick={() => pickFile(r)}
                        >
                          {r.status === "needs_reprint" ? "Upload new picture" : "Upload"}
                        </Button>
                      ) : r.status === "in_review" && !r.called_at ? (
                        <div className="flex items-center gap-3">
                          {r.has_image && <Picture row={r} />}
                          <Button size="xs" variant="secondary" icon="refresh" loading={busy === r.ref} onClick={() => pickFile(r)}>
                            Replace picture
                          </Button>
                        </div>
                      ) : (
                        <span className="text-ink-faint">Uploaded</span>
                      )}
                    </Td>
                  )}
                  {view === "all" && (
                    <Td>{r.has_image ? <Picture row={r} /> : <span className="text-ink-faint">-</span>}</Td>
                  )}
                </tr>
              ))
            )}
            {data.total > 0 && (
              <tr>
                <td colSpan={cols} className="p-0">
                  <Pagination
                    page={data.page}
                    limit={data.limit}
                    total={data.total}
                    totalPages={data.total_pages}
                    onPage={setPage}
                    unit="records"
                  />
                </td>
              </tr>
            )}
          </Tbody>
        )}
      </TableShell>

      {pending && (
        <Modal
          title={pending.row.status === "in_review" ? "Replace the picture" : "Check the picture"}
          onClose={closePreview}
          wide
          footer={
            <>
              <Button variant="secondary" onClick={closePreview}>
                Cancel
              </Button>
              <Button variant="secondary" icon="refresh" onClick={() => pickFile(pending.row)}>
                Choose another
              </Button>
              <Button icon="upload" loading={busy === pending.row.ref} onClick={() => void confirmUpload()}>
                {pending.row.status === "in_review" ? "Replace picture" : "Upload picture"}
              </Button>
            </>
          }
        >
          <p className="mb-3 text-sm text-ink-muted">
            {printName(pending.row)} - {KIND_LABEL[pending.row.kind]}.{" "}
            {pending.row.status === "in_review"
              ? "The current picture will be deleted and replaced by this one."
              : "Is the name clear and the whole brick in the picture? If not, choose another."}
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={pending.url} alt="Picture to upload" className="mx-auto max-h-[60vh] w-auto rounded-control ring-1 ring-line-soft" />
        </Modal>
      )}
      {bulk && (
        <BulkUpload
          onClose={() => setBulk(false)}
          onDone={(added) => {
            setBulk(false);
            toast.success(`${added} record${added === 1 ? "" : "s"} added`, "They are on the print list.");
            void load();
          }}
        />
      )}
      {adding && (
        <AddRecord
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            toast.success("Record added", "It is on the print list.");
            void load();
          }}
        />
      )}
      {sendingBack && (
        <SendBack
          row={sendingBack}
          onClose={() => setSendingBack(null)}
          onDone={() => {
            setSendingBack(null);
            toast.success("Sent back to the printer");
            void load();
          }}
        />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the dialogs */

function AddRecord({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [f, setF] = useState({
    donor_name: "",
    honoree_name: "",
    phone: "",
    amount: "",
    receipt_number: "",
    kind: "",
    priority: "medium",
    donated_on: "",
  });
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));

  const phone = f.phone.replace(/\D/g, "");
  const missing = {
    donor_name: !f.donor_name.trim(),
    phone: phone.length < 10,
    amount: !(Number(f.amount) >= 1500),
    kind: !f.kind,
  };
  const invalid = Object.values(missing).some(Boolean);

  async function save() {
    setShown(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await apiClient.post("/api/seva-wall", { ...f, amount: Number(f.amount) });
      onAdded();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add record"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="plus" loading={busy} onClick={() => void save()}>
            Add record
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-ink-muted">
        For a donation DRM does not have. It joins the print list and changes nothing else - no donation, receipt or
        total is created.
      </p>
      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Donor name" required error={shown && missing.donor_name ? "Enter the donor name." : undefined}>
          <Input value={f.donor_name} onChange={(e) => set({ donor_name: e.target.value })} invalid={shown && missing.donor_name} />
        </Field>
        <Field label="Honoree name" hint="Optional - printed if given">
          <Input value={f.honoree_name} onChange={(e) => set({ honoree_name: e.target.value })} />
        </Field>
        <Field label="Phone number" required error={shown && missing.phone ? "Enter the 10-digit number." : undefined}>
          <Input inputMode="numeric" value={f.phone} onChange={(e) => set({ phone: e.target.value })} invalid={shown && missing.phone} />
        </Field>
        <Field label="Amount donated" required error={shown && missing.amount ? "Enter 1500 or more." : undefined}>
          <Input inputMode="numeric" value={f.amount} onChange={(e) => set({ amount: e.target.value })} invalid={shown && missing.amount} />
        </Field>
        <Field label="Donation receipt no." hint="Optional for now">
          <Input value={f.receipt_number} onChange={(e) => set({ receipt_number: e.target.value })} />
        </Field>
        <Field label="Seva" required error={shown && missing.kind ? "Choose the seva." : undefined}>
          <Select value={f.kind} onChange={(v) => set({ kind: v })} placeholder="Choose…" ariaLabel="Seva">
            <option value="brick">Brick seva</option>
            <option value="square">Square foot seva</option>
            <option value="mandir">Mandir nirmana seva</option>
          </Select>
        </Field>
        <Field label="Priority">
          <Select value={f.priority} onChange={(v) => set({ priority: v })} ariaLabel="Priority">
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </Field>
        <Field label="Donation date" hint="Optional">
          <Input type="date" value={f.donated_on} onChange={(e) => set({ donated_on: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}

function SendBack({ row, onClose, onDone }: { row: Row; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (!note.trim()) return setError("Say what is wrong, so the printer knows what to fix.");
    setBusy(true);
    setError(null);
    try {
      await apiClient.post(`/api/seva-wall/${row.ref}/send-back`, { note: note.trim() });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Send back to the printer"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" icon="arrowLeft" loading={busy} onClick={() => void send()}>
            Send back
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-ink-muted">
        {row.donor_name} - {KIND_LABEL[row.kind]}. The brick goes to the top of the print list with your reason. The
        picture is kept.
      </p>
      {error && (
        <div className="mb-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <Field label="What is wrong with it?" required>
        <Textarea
          value={note}
          maxLength={300}
          placeholder="For example: the name is cut off, or the picture is blurry"
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

interface BulkResult {
  dry_run: boolean;
  ready: number;
  added: number;
  problems: number;
  duplicates: number;
  issues: { row: number; status: "error" | "duplicate"; message?: string; donor_name?: string }[];
}

/**
 * Add many records from a sheet. The file is read, then CHECKED without writing
 * anything, so the person sees how many are ready and which rows have a problem
 * (and why) before they press Import. Good rows go in and bad rows are skipped;
 * one bad row never blocks the rest.
 */
function BulkUpload({ onClose, onDone }: { onClose: () => void; onDone: (added: number) => void }) {
  const [sheet, setSheet] = useState<ParsedSheet | null>(null);
  const [fileName, setFileName] = useState("");
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = (s: ParsedSheet, dryRun: boolean) =>
    apiClient.post<BulkResult>("/api/seva-wall/bulk", {
      headers: s.headers,
      rows: s.rows,
      row_numbers: s.rowNumbers,
      dry_run: dryRun,
    });

  async function choose(file: File | undefined) {
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const sheets = await readSpreadsheet(file);
      const first = sheets[0];
      setSheet(first);
      setFileName(file.name);
      setResult(await send(first, true));
    } catch (e) {
      setSheet(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function importNow() {
    if (!sheet) return;
    setBusy(true);
    setError(null);
    try {
      const r = await send(sheet, false);
      onDone(r.added);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Bulk upload"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button icon="upload" disabled={!result || result.ready === 0} loading={busy} onClick={() => void importNow()}>
            {result && result.ready > 0 ? `Add ${result.ready} record${result.ready === 1 ? "" : "s"}` : "Add records"}
          </Button>
        </>
      }
    >
      <input
        ref={inputRef}
        type="file"
        accept={SPREADSHEET_ACCEPT}
        className="hidden"
        onChange={(e) => void choose(e.target.files?.[0])}
      />
      <div className="mb-4 space-y-2 text-sm text-ink-muted">
        <p>
          Upload a CSV or Excel file. It needs the columns <b className="text-ink">Donor name, Phone, Amount, Seva</b>.
          These are optional: <b className="text-ink">Honoree name, Receipt no., Priority, Date</b>. A missing or blank
          priority becomes Medium. Only donations of Rs 1,500 or more are added.
        </p>
        <p>The file is checked first and nothing is added until you press the button.</p>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon="file" loading={busy && !result} onClick={() => inputRef.current?.click()}>
          {sheet ? "Choose another file" : "Choose file"}
        </Button>
        <Button
          variant="ghost"
          icon="download"
          onClick={() =>
            downloadSample("seva-wall-sample.csv", [
              ["Donor Name", "Honoree Name", "Phone", "Amount", "Receipt No", "Seva", "Priority", "Date"],
              ["Asha Rao", "Late Sri Rao", "9876543210", "1500", "", "Brick seva", "Medium", "21/10/2026"],
              ["Bala Krishna", "", "9876543211", "5000", "HKMI/2026/1", "Square foot seva", "High", ""],
            ])
          }
        >
          Download sample
        </Button>
        {fileName && <span className="text-sm text-ink-muted">{fileName}</span>}
      </div>

      {error && (
        <div className="mb-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}

      {result && (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone="good" dot>
              {number(result.ready)} ready to add
            </Badge>
            {result.problems > 0 && (
              <Badge tone="danger" dot>
                {number(result.problems)} with a problem
              </Badge>
            )}
            {result.duplicates > 0 && (
              <Badge tone="warn" dot>
                {number(result.duplicates)} already there
              </Badge>
            )}
          </div>
          {result.issues.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-control ring-1 ring-line-soft">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-sunken text-left text-2xs uppercase tracking-[0.06em] text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Donor</th>
                    <th className="px-3 py-2">Why it is skipped</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {result.issues.map((x) => (
                    <tr key={x.row}>
                      <td className="px-3 py-2 tabular-nums">{x.row}</td>
                      <td className="px-3 py-2">{x.donor_name || "-"}</td>
                      <td className="px-3 py-2 text-ink-soft">
                        {x.message ? x.message[0].toUpperCase() + x.message.slice(1) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
