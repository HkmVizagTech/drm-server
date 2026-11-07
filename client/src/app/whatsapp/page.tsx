"use client";

// WhatsApp chats: callers and admins talk to donors.
//
// Left, every conversation (anyone who wrote to the temple's number, and anyone a caller started a chat
// with); right, the thread. It is LIVE: the server pushes a note the moment a donor writes or a tick
// changes (one open stream), and the screen then fetches just that conversation. If the stream drops,
// the screen falls back to asking every few seconds and reconnects by itself.
//
// The rules WhatsApp enforces are shown, not hidden: free text and files only within 24 hours of the
// donor's last message, an approved template after that, and nothing at all to a donor who wrote STOP.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSessionState } from "@/lib/session-state";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiClient, apiUrl } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { clockTime, dateTime, istDateKey, istToday } from "@/lib/format";
import { Alert, Avatar, Badge, Button, EmptyState, Input, SearchInput, Skeleton, Textarea } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";
import { WA_PREFILL_KEY } from "@/components/seva-wall/wall-table";

interface Conv {
  id: string;
  phone: string;
  person_id: string | null;
  name: string | null;
  assigned_to: string | null;
  assigned_name: string | null;
  last_message_at: string | null;
  last_message_text: string | null;
  last_message_dir: string | null;
  unread_count: number;
  opted_out: boolean;
  window_open: boolean;
  window_ends_at: string | null;
}
interface Msg {
  id: string;
  direction: "inbound" | "outbound";
  msg_type: string;
  body: string | null;
  media_mime: string | null;
  media_name: string | null;
  media_size: number | null;
  template_name: string | null;
  status: string;
  error: string | null;
  created_at: string;
  has_media: boolean;
  sent_by_name: string | null;
}
interface Tpl { name: string; language: string; body: string; paramCount: number; header: "IMAGE" | "VIDEO" | "DOCUMENT" | null }
interface Team { id: string; name: string; role: string }
interface AttachedFile { name: string; mime: string; size: number; base64: string; preview: string | null }

const HEADER_ACCEPT = { IMAGE: "image/jpeg,image/png", VIDEO: "video/mp4,video/3gpp", DOCUMENT: ".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt" } as const;
const MAX_MB = 15;
const ACCEPT = "image/jpeg,image/png,video/mp4,video/3gpp,audio/mpeg,audio/ogg,audio/aac,audio/mp4,audio/amr,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt";
// Quick replies a caller can drop into the box and edit before sending.
const QUICK_REPLIES = [
  "Hare Krishna! 🙏 How may I help you?",
  "Thank you for your seva. Your receipt will reach you shortly.",
  "Could you please share the payment screenshot or transaction ID?",
  "We will call you back shortly. Hare Krishna!",
  "Thank you so much for your support. May Sri Krishna bless you and your family. 🙏",
];

const shownPhone = (p: string) => (p.length === 10 ? `+91 ${p.slice(0, 5)} ${p.slice(5)}` : `+${p}`);
const phoneOf = (d: string) => (d.length >= 12 && d.startsWith("91") ? d.slice(2) : d.length === 11 && d.startsWith("0") ? d.slice(1) : d);
const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
/** A picture WhatsApp will carry: JPEG or PNG as is, anything else (WebP) redrawn as a JPEG. */
async function whatsappPicture(blob: Blob): Promise<Blob> {
  if (blob.type === "image/jpeg" || blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  return new Promise((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("convert"))), "image/jpeg", 0.92));
}
const asDataUrl = (b: Blob) =>
  new Promise<string>((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(new Error("read"));
    r.readAsDataURL(b);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function leftLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function dayLabel(iso: string): string {
  const key = istDateKey(iso);
  if (key === istToday()) return "Today";
  if (key === istDateKey(new Date(Date.now() - 86400000))) return "Yesterday";
  return dateTime(iso).split(",")[0];
}
const listTime = (iso: string | null) => (!iso ? "" : istDateKey(iso) === istToday() ? clockTime(iso) : dayLabel(iso));

function Ticks({ m }: { m: Msg }) {
  if (m.direction !== "outbound") return null;
  if (m.status === "failed") return <span title={m.error ?? "Not delivered"} className="text-danger"><Icon name="alert" size={13} /></span>;
  if (m.status === "queued") return <Icon name="clock" size={12} className="text-ink-faint" />;
  const two = m.status === "delivered" || m.status === "read";
  return (
    <span title={m.status} className={`inline-flex ${m.status === "read" ? "text-sky-500" : "text-ink-faint"}`}>
      <Icon name="check" size={13} />
      {two && <Icon name="check" size={13} className="-ml-2" />}
    </span>
  );
}

const Paperclip = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="m21.4 11.1-9.2 9.2a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5" />
  </svg>
);
const SendIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3.4 20.4 21 12 3.4 3.6 3.3 10l12.6 2-12.6 2z" /></svg>
);

/** A picture, video, voice note or file in a bubble. Fetched with the login, since a bare <img src> cannot carry it. */
function Attachment({ m, onOpen }: { m: Msg; onOpen: (url: string) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let made: string | null = null;
    let dead = false;
    apiClient
      .getBlob(`/api/wa-chat/messages/${m.id}/media`)
      .then((b) => {
        if (dead) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => !dead && setFailed(true));
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [m.id]);
  if (failed) return <p className="flex items-center gap-1.5 text-xs italic text-ink-faint"><Icon name="alert" size={13} /> This file is no longer available.</p>;
  if (!url) return <div className="h-40 w-56 max-w-full animate-pulse rounded-lg bg-black/5" />;
  if (m.msg_type === "image" || m.msg_type === "sticker")
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt={m.body || "Picture"} onClick={() => onOpen(url)} className="max-h-80 w-full max-w-xs cursor-zoom-in rounded-lg object-cover" />;
  if (m.msg_type === "video") return <video src={url} controls className="max-h-80 max-w-xs rounded-lg" />;
  if (m.msg_type === "audio") return <audio src={url} controls className="max-w-full" />;
  return (
    <a href={url} download={m.media_name || "file"} className="flex items-center gap-3 rounded-lg bg-black/5 px-3 py-2.5 text-sm text-ink hover:bg-black/10">
      <span className="grid h-9 w-9 flex-none place-items-center rounded-md bg-white text-brand-700"><Icon name="file" size={18} /></span>
      <span className="min-w-0"><span className="block truncate font-medium">{m.media_name || "Document"}</span>
      {m.media_size ? <span className="text-xs text-ink-faint">{Math.max(1, Math.round(m.media_size / 1024))} KB · tap to download</span> : null}</span>
    </a>
  );
}

/** One open stream from the server; it says which conversation changed. Reconnects by itself. */
function useChatStream(onEvent: (e: { t: string; c: string }) => void): boolean {
  const [live, setLive] = useState(false);
  const handler = useRef(onEvent);
  useEffect(() => {
    handler.current = onEvent;
  });
  useEffect(() => {
    let stop = false;
    const ctrl = { current: null as AbortController | null };
    (async () => {
      let delay = 1000;
      while (!stop) {
        ctrl.current = new AbortController();
        try {
          const token = localStorage.getItem("token");
          const res = await fetch(apiUrl("/api/wa-chat/stream"), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.current.signal });
          if (res.status === 401 || res.status === 403) return;
          if (!res.ok || !res.body) throw new Error(String(res.status));
          setLive(true);
          delay = 1000;
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let i: number;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const block = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const line = block.split("\n").find((l) => l.startsWith("data: "));
              if (line) {
                try {
                  handler.current(JSON.parse(line.slice(6)));
                } catch {
                  /* a malformed line is skipped */
                }
              }
            }
          }
        } catch {
          /* dropped: reconnect below */
        }
        setLive(false);
        if (stop) return;
        await sleep(delay);
        delay = Math.min(delay * 2, 15000);
      }
    })();
    return () => {
      stop = true;
      ctrl.current?.abort();
    };
  }, []);
  return live;
}


interface Found { phone: string; name: string | null; in_drm: boolean; person_id: string | null }
interface SyncState { status: string; page: number; pages: number; stored: number; error: string | null }

/** Find anyone to message: donors in DRM and every contact in the temple's WhatsApp, or type a number. */
function NewChatPanel({ isAdmin, onPick }: { isAdmin: boolean; onPick: (phone: string, personId: string | null) => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[]>([]);
  const [busy, setBusy] = useState(false);
  const [sync, setSync] = useState<SyncState | null>(null);
  const shown = q.trim().length >= 2 ? found : [];
  const digits = q.replace(/\D/g, "");
  const typedNumber = digits.length >= 10 && digits.length === q.replace(/[\s+\-()]/g, "").length;

  useEffect(() => {
    if (q.trim().length < 2) return;
    let dead = false;
    const t = setTimeout(() => {
      setBusy(true);
      apiClient
        .get<{ contacts: Found[] }>(`/api/wa-chat/contacts?q=${encodeURIComponent(q.trim())}`)
        .then((r) => !dead && setFound(r.contacts))
        .catch(() => !dead && setFound([]))
        .finally(() => !dead && setBusy(false));
    }, 250);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [q]);

  const loadSync = useCallback(() => apiClient.get<SyncState>("/api/wa-chat/contacts/sync").then(setSync).catch(() => undefined), []);
  useEffect(() => {
    void loadSync();
  }, [loadSync]);
  useEffect(() => {
    if (sync?.status !== "running") return;
    const t = setInterval(() => void loadSync(), 2500);
    return () => clearInterval(t);
  }, [sync?.status, loadSync]);

  async function startSync() {
    try {
      await apiClient.post("/api/wa-chat/contacts/sync", {});
      void loadSync();
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    }
  }

  return (
    <div className="space-y-2">
      <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a name or number, or type a new number" />
      {typedNumber && (
        <button className="flex w-full items-center gap-3 rounded-lg bg-surface px-3 py-2 text-left text-sm hover:bg-brand-50" onClick={() => onPick(digits, null)}>
          <span className="grid h-8 w-8 place-items-center rounded-full bg-[#25D366]/15 text-[#1da851]"><Icon name="plus" size={15} /></span>
          <span>Message <b>{shownPhone(phoneOf(digits))}</b></span>
        </button>
      )}
      <div>
        {shown.map((c) => (
          <button key={c.phone} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-surface" onClick={() => onPick(c.phone, c.person_id)}>
            <Avatar name={c.name || c.phone} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{c.name || "No name saved"}</span>
              <span className="block text-xs text-ink-muted">{shownPhone(c.phone)}</span>
            </span>
            {c.in_drm && <span className="rounded bg-brand-50 px-1.5 py-0.5 text-2xs font-medium text-brand-800">Donor</span>}
          </button>
        ))}
        {!busy && q.trim().length >= 2 && !shown.length && !typedNumber && <p className="px-2 py-3 text-center text-xs text-ink-muted">No one matches. Type their full number to start a new chat.</p>}
        {q.trim().length < 2 && <p className="px-2 py-2 text-center text-xs text-ink-muted">Type at least 2 letters or digits.</p>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line-soft pt-2 text-2xs text-ink-muted">
        <span>
          {sync?.status === "running"
            ? `Copying Flaxxa contacts… page ${sync.page} of ${sync.pages || "?"}`
            : sync?.status === "failed"
              ? `Last sync stopped: ${sync.error}`
              : sync && sync.stored > 0
                ? `${sync.stored.toLocaleString("en-IN")} WhatsApp contacts searchable`
                : "WhatsApp contacts have not been copied yet"}
        </span>
        {isAdmin && sync?.status !== "running" && <Button size="xs" variant="secondary" icon="refresh" onClick={() => void startSync()}>{sync && sync.stored > 0 ? "Sync again" : "Copy contacts"}</Button>}
      </div>
    </div>
  );
}

function ChatInner() {
  const { user } = useAuth();
  const sp = useSearchParams();
  const [convs, setConvs] = useState<Conv[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [filter, setFilter] = useSessionState<"all" | "unread" | "mine" | "unassigned">("whatsapp:filter", "all");
  const [q, setQ] = useSessionState("whatsapp:q", "");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [more, setMore] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<AttachedFile | null>(null);
  const [sending, setSending] = useState(false);
  const [templates, setTemplates] = useState<Tpl[] | null>(null);
  const [tplName, setTplName] = useState("");
  const [showTpl, setShowTpl] = useState(false); // the template panel, opened by the 📋 button or after a 24-hour refusal
  const [tplParams, setTplParams] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [team, setTeam] = useState<Team[]>([]);
  const [status, setStatus] = useState<{ configured: boolean; receiving: boolean } | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [away, setAway] = useState(0); // new messages while scrolled up
  const [now, setNow] = useState(() => Date.now());
  const [extra, setExtra] = useState<Conv | null>(null); // a chat just started, not in the list yet
  const [wallRef, setWallRef] = useState<string | null>(null); // a Seva wall brick being sent from here
  const cursor = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const tplFileInput = useRef<HTMLInputElement>(null);
  const activeRef = useRef<string | null>(null);
  const listTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    activeRef.current = activeId;
    // On a phone the bottom bar steps aside while a conversation is open (see globals.css).
    document.body.dataset.chatOpen = activeId ? "1" : "";
    return () => {
      delete document.body.dataset.chatOpen;
    };
  }, [activeId]);

  const active = useMemo(() => convs.find((c) => c.id === activeId) ?? null, [convs, activeId]);
  const current = active ?? (extra && extra.id === activeId ? extra : null);

  /* ---- the list ---- */
  const loadList = useCallback(async () => {
    try {
      const r = await apiClient.get<{ conversations: Conv[] }>(`/api/wa-chat/conversations?filter=${filter}&q=${encodeURIComponent(q.trim())}`);
      setConvs(r.conversations);
    } catch (e) {
      if (visible()) toast((e as Error).message, { tone: "danger" });
    } finally {
      setLoadingList(false);
    }
  }, [filter, q]);
  useEffect(() => {
    const t = setTimeout(() => void loadList(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [loadList, q]);

  useEffect(() => {
    apiClient.get<{ configured: boolean; receiving: boolean }>("/api/wa-chat/status").then(setStatus).catch(() => undefined);
    apiClient.get<{ users: Team[] }>("/api/wa-chat/team").then((r) => setTeam(r.users)).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  /* ---- the thread ---- */
  const merge = useCallback((incoming: Msg[]) => {
    setMsgs((cur) => {
      const byId = new Map(cur.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    });
  }, []);

  // What is new or has changed a tick since the last look. Overlaps by a few seconds, merged by id.
  const fetchDelta = useCallback(async () => {
    const id = activeRef.current;
    if (!id || !cursor.current) return;
    try {
      const after = new Date(new Date(cursor.current).getTime() - 5000).toISOString();
      const r = await apiClient.get<{ messages: Msg[]; server_time: string }>(`/api/wa-chat/conversations/${id}/messages?after=${encodeURIComponent(after)}`);
      if (activeRef.current !== id) return;
      cursor.current = r.server_time;
      if (r.messages.length) {
        const fresh = r.messages.filter((m) => m.direction === "inbound").length;
        if (!stick.current && fresh) setAway((n) => n + fresh);
        merge(r.messages);
        if (r.messages.some((m) => m.direction === "inbound") && visible()) void apiClient.post(`/api/wa-chat/conversations/${id}/read`, {}).catch(() => undefined);
      }
    } catch {
      /* a missed beat is made up on the next */
    }
  }, [merge]);

  const live = useChatStream(
    useCallback(
      (e) => {
        // The list: soon, and once for a burst.
        if (!listTimer.current) {
          listTimer.current = setTimeout(() => {
            listTimer.current = null;
            void loadList();
          }, 250);
        }
        if (e.c === activeRef.current) void fetchDelta();
      },
      [loadList, fetchDelta]
    )
  );

  // The safety net: while the live stream is up, a slow look; when it is down, a quick one.
  useEffect(() => {
    const t = setInterval(() => visible() && void loadList(), live ? 30000 : 6000);
    return () => clearInterval(t);
  }, [loadList, live]);
  useEffect(() => {
    if (!activeId) return;
    const t = setInterval(() => visible() && void fetchDelta(), live ? 15000 : 3000);
    return () => clearInterval(t);
  }, [activeId, fetchDelta, live]);
  // Back to the tab: catch up at once.
  useEffect(() => {
    const on = () => {
      if (visible()) {
        void loadList();
        void fetchDelta();
      }
    };
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [loadList, fetchDelta]);

  const openConv = useCallback(async (c: Conv) => {
    setActiveId(c.id);
    activeRef.current = c.id;
    setExtra((e) => (e && e.id === c.id ? e : null));
    setMsgs([]);
    setMore(false);
    setDraft("");
    setFile(null);
    setTplName("");
    setShowTpl(false);
    setWallRef(null);
    setAway(0);
    setLoadingThread(true);
    cursor.current = null;
    stick.current = true;
    try {
      const r = await apiClient.get<{ messages: Msg[]; more: boolean; server_time: string }>(`/api/wa-chat/conversations/${c.id}/messages`);
      setMsgs(r.messages);
      setMore(r.more);
      cursor.current = r.server_time;
      if (c.unread_count > 0) {
        void apiClient.post(`/api/wa-chat/conversations/${c.id}/read`, {}).then(() => setConvs((l) => l.map((x) => (x.id === c.id ? { ...x, unread_count: 0 } : x))));
      }
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    } finally {
      setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, activeId]);

  function toBottom() {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    stick.current = true;
    setAway(0);
  }

  async function loadEarlier() {
    if (!activeId || !msgs.length) return;
    const el = scroller.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const r = await apiClient.get<{ messages: Msg[]; more: boolean }>(`/api/wa-chat/conversations/${activeId}/messages?before=${encodeURIComponent(msgs[0].created_at)}`);
      stick.current = false;
      merge(r.messages);
      setMore(r.more);
      requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - prevHeight));
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    }
  }

  /** The Seva wall's WhatsApp icon left a brick for this donor: put its picture and message in the box. */
  async function loadWallPrefill(phone: string) {
    let p: { ref: string; phone: string; message: string } | null = null;
    try {
      p = JSON.parse(sessionStorage.getItem(WA_PREFILL_KEY) || "null");
      sessionStorage.removeItem(WA_PREFILL_KEY);
    } catch {
      p = null;
    }
    if (!p || p.phone !== phone) return;
    setDraft(p.message);
    setWallRef(p.ref);
    try {
      const pic = await whatsappPicture(await apiClient.getBlob(`/api/seva-wall/${p.ref}/image`));
      const dataUrl = await asDataUrl(pic);
      setFile({ name: pic.type === "image/png" ? "brick.png" : "brick.jpg", mime: pic.type, size: pic.size, base64: dataUrl.split(",")[1] ?? "", preview: dataUrl });
    } catch {
      toast("The brick picture could not be loaded - attach it by hand.", { tone: "warn" });
    }
  }

  /** After the brick went out from here, tick it off on the Seva wall too. */
  async function markWallSent(status: string) {
    if (!wallRef || status === "failed") return;
    const ref = wallRef;
    setWallRef(null);
    try {
      await apiClient.post(`/api/seva-wall/${ref}/mark-sent`, {});
      toast("Marked \"WhatsApp sent\" on the Seva wall");
    } catch {
      /* already marked, or not waiting: nothing to do */
    }
  }

  /* ---- deep link: /whatsapp?phone=... or ?person=... ---- */
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    const phone = sp.get("phone");
    const person = sp.get("person");
    const key = phone || person;
    if (!key || startedFor.current === key) return;
    startedFor.current = key;
    apiClient
      .post<{ conversation: Conv }>("/api/wa-chat/conversations", person ? { person_id: person } : { phone })
      .then(async (r) => {
        setExtra(r.conversation);
        await openConv(r.conversation);
        await loadWallPrefill(r.conversation.phone);
      })
      .catch((e) => toast((e as Error).message, { tone: "danger" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadWallPrefill only uses setters and the API
  }, [sp, openConv]);

  async function startChat(phone: string, personId: string | null) {
    try {
      const r = await apiClient.post<{ conversation: Conv }>("/api/wa-chat/conversations", personId ? { person_id: personId } : { phone });
      setNewOpen(false);
      setExtra(r.conversation);
      void openConv(r.conversation);
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    }
  }

  /* ---- sending ---- */
  function applySent(r: { message: Msg; conversation: Conv }) {
    stick.current = true;
    merge([r.message]);
    setExtra((e) => (e && e.id === r.conversation.id ? r.conversation : e));
    setConvs((l) => [r.conversation, ...l.filter((c) => c.id !== r.conversation.id)]);
    if (r.message.status === "failed") toast(r.message.error || "WhatsApp did not accept the message.", { tone: "danger" });
  }

  async function sendText(text: string, ref = uid()) {
    if (!current || sending) return;
    setSending(true);
    try {
      applySent(await apiClient.post(`/api/wa-chat/conversations/${current.id}/messages`, { text, client_ref: ref }));
      setDraft("");
    } catch (e) {
      const err = e as Error & { code?: string };
      toast(err.message, { tone: "danger" });
      if (err.code === "window_closed" || err.code === "opted_out") void loadList();
    } finally {
      setSending(false);
    }
  }

  async function sendFile() {
    if (!current || !file || sending) return;
    setSending(true);
    try {
      const r = await apiClient.post<{ message: Msg; conversation: Conv }>(`/api/wa-chat/conversations/${current.id}/media`, {
        filename: file.name, mime: file.mime, base64: file.base64, caption: draft.trim(), client_ref: uid(),
      });
      applySent(r);
      void markWallSent(r.message.status);
      setFile(null);
      setDraft("");
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    } finally {
      setSending(false);
    }
  }

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    if (f.size > MAX_MB * 1048576) return toast(`That file is larger than ${MAX_MB} MB.`, { tone: "danger" });
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      setFile({ name: f.name || "picture.png", mime: f.type, size: f.size, base64, preview: f.type.startsWith("image/") ? String(reader.result) : null });
    };
    reader.onerror = () => toast("Could not read that file.", { tone: "danger" });
    reader.readAsDataURL(f);
  }

  useEffect(() => {
    if (showTpl && current && !current.opted_out && templates === null) {
      apiClient
        .get<{ templates: Tpl[] }>("/api/wa-chat/templates")
        .then((r) => setTemplates(r.templates))
        .catch((e) => {
          setTemplates([]);
          toast((e as Error).message, { tone: "danger" });
        });
    }
  }, [showTpl, current, templates]);
  const tpl = templates?.find((t) => t.name === tplName) ?? null;
  const tplPreview = tpl ? tpl.body.replace(/\{\{(\d+)\}\}/g, (_m, n) => tplParams[Number(n) - 1] || `{{${n}}}`) : "";

  async function sendTemplate() {
    if (!current || !tpl || sending) return;
    setSending(true);
    try {
      const sent = await apiClient.post<{ message: Msg; conversation: Conv }>(`/api/wa-chat/conversations/${current.id}/template`, {
          name: tpl.name, language: tpl.language, params: tplParams.slice(0, tpl.paramCount), client_ref: uid(),
          ...(tpl.header && file ? { filename: file.name, mime: file.mime, base64: file.base64 } : {}),
      });
      applySent(sent);
      void markWallSent(sent.message.status);
      setTplName("");
      setTplParams([]);
      setFile(null);
      setShowTpl(false);
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    } finally {
      setSending(false);
    }
  }

  async function assign(userId: string | null) {
    if (!current) return;
    try {
      const r = await apiClient.put<{ conversation: Conv }>(`/api/wa-chat/conversations/${current.id}/assign`, { user_id: userId });
      setConvs((l) => l.map((c) => (c.id === r.conversation.id ? r.conversation : c)));
      setExtra((e) => (e && e.id === r.conversation.id ? r.conversation : e));
    } catch (e) {
      toast((e as Error).message, { tone: "danger" });
    }
  }

  const isAdmin = user?.role === "admin";
  const list = convs.some((c) => c.id === extra?.id) || !extra ? convs : [extra, ...convs];
  const windowMs = current?.window_ends_at ? new Date(current.window_ends_at).getTime() - now : 0;
  // Like WhatsApp itself: the box, the paperclip and Send are always there. Whether a message may go is
  // WhatsApp's call (DRM only knows replies it has seen); a refusal comes back on the bubble with the reason.
  const canType = !!current && !current.opted_out;
  const replied = !!current && current.window_open && windowMs > 0;
  const totalUnread = convs.reduce((n, c) => n + (c.unread_count > 0 ? 1 : 0), 0);

  return (
    <div className={`flex min-h-[420px] overflow-hidden border-line-soft bg-surface lg:h-[calc(100dvh-5rem)] lg:rounded-2xl lg:border lg:shadow-sm ${activeId ? "h-[calc(100dvh-3.5rem)]" : "h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom))]"}`}>
      {/* ---------------------------------------------------- conversations */}
      <aside className={`${activeId ? "hidden md:flex" : "flex"} w-full flex-none flex-col border-r border-line-soft bg-surface md:w-[22rem] xl:w-[28rem]`}>
        <div className="space-y-3 px-4 pb-3 pt-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-ink">Chats</h1>
              {totalUnread > 0 && <span className="rounded-full bg-[#25D366] px-2 py-0.5 text-2xs font-semibold text-white">{totalUnread} new</span>}
            </div>
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center gap-1.5 text-2xs ${live ? "text-good" : "text-warn"}`} title={live ? "Messages arrive instantly" : "Reconnecting… checking every few seconds"}>
                <span className={`h-2 w-2 rounded-full ${live ? "bg-good" : "animate-pulse bg-warn"}`} />
                {live ? "Live" : "Reconnecting"}
              </span>
              <Button size="sm" icon={newOpen ? "x" : "plus"} variant={newOpen ? "secondary" : "primary"} onClick={() => setNewOpen((v) => !v)}>{newOpen ? "Close" : "New chat"}</Button>
            </div>
          </div>
          {!newOpen && <SearchInput value={q} onChange={setQ} placeholder="Search your chats" />}
          {!newOpen && <div className="grid grid-cols-4 gap-1 rounded-lg bg-sunken p-1 text-xs">
            {(["all", "unread", "mine", "unassigned"] as const).map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2 py-1.5 font-medium capitalize transition-colors ${filter === f ? "bg-surface text-brand-800 shadow-sm" : "text-ink-muted hover:text-ink"}`}>
                {f}
              </button>
            ))}
          </div>}
        </div>
        {newOpen ? (
          <div className="flex-1 overflow-y-auto border-t border-line-soft p-3">
            <NewChatPanel isAdmin={user?.role === "admin"} onPick={(phone, personId) => void startChat(phone, personId)} />
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto border-t border-line-soft">
          {loadingList ? (
            <div className="space-y-3 p-4">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
          ) : list.length === 0 ? (
            <EmptyState icon="message" title={q || filter !== "all" ? "No chats match" : "No chats yet"} message={q || filter !== "all" ? "Try another search or filter." : "When a donor writes to the temple's WhatsApp, or you start a chat, it shows here."} />
          ) : (
            list.map((c) => {
              const unread = c.unread_count > 0;
              return (
                <button key={c.id} onClick={() => void openConv(c)} className={`flex w-full items-center gap-3 border-b border-line-soft/70 px-4 py-3 text-left transition-colors hover:bg-sunken ${c.id === activeId ? "bg-brand-50" : ""}`}>
                  <Avatar name={c.name || c.phone} size="lg" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`truncate text-sm ${unread ? "font-semibold text-ink" : "font-medium text-ink"}`}>{c.name || shownPhone(c.phone)}</span>
                      <span className={`flex-none text-2xs ${unread ? "font-semibold text-[#1da851]" : "text-ink-faint"}`}>{listTime(c.last_message_at)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                      <span className={`truncate text-[13px] ${unread ? "text-ink" : "text-ink-muted"}`}>{c.last_message_dir === "outbound" ? "You: " : ""}{c.last_message_text || "No messages yet"}</span>
                      {unread && <span className="grid h-5 min-w-5 flex-none place-items-center rounded-full bg-[#25D366] px-1.5 text-2xs font-semibold text-white">{c.unread_count > 99 ? "99+" : c.unread_count}</span>}
                    </span>
                    {(c.opted_out || c.assigned_name) && (
                      <span className="mt-1 flex flex-wrap gap-1.5 text-2xs">
                        {c.opted_out && <span className="rounded bg-danger-wash px-1.5 py-0.5 font-medium text-danger">Said STOP</span>}
                        
                        {c.assigned_name && <span className="rounded bg-sunken px-1.5 py-0.5 text-ink-muted">{c.assigned_name}</span>}
                      </span>
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>
        )}
      </aside>

      {/* ---------------------------------------------------------- thread */}
      <section className={`${activeId ? "flex" : "hidden md:flex"} relative min-w-0 flex-1 flex-col`}
        onDragOver={(e) => { if (canType) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); if (canType) pickFile(e.dataTransfer.files?.[0]); }}
      >
        {!current ? (
          <div className="grid flex-1 place-items-center bg-[#f7f5f0] p-6">
            <div className="max-w-sm text-center">
              <span className="mx-auto grid h-16 w-16 place-items-center rounded-full bg-[#25D366]/15 text-[#1da851]"><Icon name="message" size={28} /></span>
              <p className="mt-4 text-base font-semibold text-ink">HKM Vizag · WhatsApp</p>
              <p className="mt-1 text-sm text-ink-muted">Pick a chat on the left, or start a new one. Pictures, files and replies all happen here.</p>
              {status && !status.configured && <Alert tone="warn" className="mt-4 text-left">WhatsApp is not connected on this server yet, so nothing can be sent.</Alert>}
              {status && status.configured && !status.receiving && <Alert tone="info" className="mt-4 text-left">Replies from donors will not appear until the incoming-message link from the WhatsApp CRM is set up.</Alert>}
            </div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-3 border-b border-line-soft bg-surface px-4 py-3">
              <button className="-ml-1 grid h-8 w-8 place-items-center rounded-full hover:bg-sunken md:hidden" onClick={() => setActiveId(null)} aria-label="Back to chats"><Icon name="arrowLeft" size={18} /></button>
              <Avatar name={current.name || current.phone} size="lg" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[15px] font-semibold leading-tight text-ink">{current.name || shownPhone(current.phone)}</p>
                <p className="mt-0.5 truncate text-xs text-ink-muted">
                  {shownPhone(current.phone)}
                  {current.person_id && <> · <Link className="font-medium text-brand-700 hover:underline" href={`/people/${current.person_id}`}>Open donor</Link></>}
                </p>
              </div>
              <div className="hidden items-center gap-2 sm:flex">
                {current.opted_out ? <Badge tone="danger">Said STOP</Badge> : replied ? <Badge tone="good" dot>Replied · {leftLabel(windowMs)} left to chat freely</Badge> : null}
              </div>
              {isAdmin ? (
                <select aria-label="Assigned to" className="h-8 max-w-36 rounded-control border border-line-strong bg-surface px-2 text-xs" value={current.assigned_to ?? ""} onChange={(e) => void assign(e.target.value || null)}>
                  <option value="">Unassigned</option>
                  {team.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              ) : current.assigned_to === user?.id ? (
                <Button size="xs" variant="ghost" onClick={() => void assign(null)}>Release</Button>
              ) : !current.assigned_to ? (
                <Button size="xs" variant="secondary" onClick={() => void assign(user?.id ?? null)}>Take chat</Button>
              ) : (
                <span className="text-xs text-ink-faint">{current.assigned_name}</span>
              )}
            </header>

            <div ref={scroller}
              onScroll={(e) => { const el = e.currentTarget; const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80; stick.current = near; if (near) setAway(0); }}
              className="relative flex-1 overflow-y-auto bg-[#f2eee6] px-3 py-4 sm:px-6"
            >
              {more && <div className="pb-3 text-center"><Button size="xs" variant="secondary" onClick={() => void loadEarlier()}>Load earlier messages</Button></div>}
              {loadingThread && <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className={`h-12 ${i % 2 ? "ml-auto w-1/2" : "w-2/3"}`} />)}</div>}
              {!loadingThread && msgs.length === 0 && <p className="mx-auto mt-16 max-w-xs rounded-lg bg-white/80 px-4 py-3 text-center text-sm text-ink-muted shadow-sm">No messages yet. Say Hare Krishna 🙏</p>}
              {msgs.map((m, i) => {
                const prev = msgs[i - 1];
                const sep = i === 0 || istDateKey(prev.created_at) !== istDateKey(m.created_at);
                const out = m.direction === "outbound";
                const groupStart = sep || !prev || prev.direction !== m.direction || prev.sent_by_name !== m.sent_by_name;
                const hasFile = m.has_media || ["image", "video", "audio", "document", "sticker"].includes(m.msg_type);
                return (
                  <div key={m.id}>
                    {sep && <div className="sticky top-0 z-10 my-3 text-center"><span className="rounded-full bg-white/90 px-3 py-1 text-2xs font-medium text-ink-muted shadow-sm">{dayLabel(m.created_at)}</span></div>}
                    <div className={`flex ${out ? "justify-end" : "justify-start"} ${groupStart ? "mt-2" : "mt-0.5"}`}>
                      <div className={`relative max-w-[85%] rounded-2xl px-3 py-2 text-[14.5px] leading-snug shadow-sm sm:max-w-[70%] ${out ? `${groupStart ? "rounded-tr-md" : ""} ${m.status === "failed" ? "bg-red-50 ring-1 ring-red-200" : "bg-[#d9fdd3]"}` : `${groupStart ? "rounded-tl-md" : ""} bg-white`}`}>
                        {out && groupStart && m.sent_by_name && <p className="mb-0.5 text-2xs font-semibold text-brand-700">{m.sent_by_name}</p>}
                        {m.template_name && <p className="mb-0.5 text-2xs font-medium uppercase tracking-wide text-ink-faint">Template · {m.template_name}</p>}
                        {hasFile && <div className={m.body ? "mb-1.5" : ""}><Attachment m={m} onOpen={setLightbox} /></div>}
                        {m.body && <p className="whitespace-pre-wrap break-words text-ink">{m.body}</p>}
                        <p className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-ink-faint">
                          {clockTime(m.created_at)} <Ticks m={m} />
                        </p>
                        {m.status === "failed" && (
                          <p className="mt-1 border-t border-red-200 pt-1 text-xs text-danger">
                            {m.error || "Not delivered."}{" "}
                            {/24 hours|re-engagement|131047/i.test(m.error ?? "") ? (
                              <button className="font-semibold underline" onClick={() => setShowTpl(true)}>Send as a template</button>
                            ) : (
                              m.msg_type === "text" && m.body && canType && <button className="font-semibold underline" onClick={() => void sendText(m.body!)}>Send again</button>
                            )}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {away > 0 && (
                <button onClick={toBottom} className="sticky bottom-2 left-full ml-auto mr-0 flex items-center gap-1.5 rounded-full bg-brand-700 px-3 py-1.5 text-xs font-medium text-white shadow-lg">
                  <Icon name="arrowDown" size={13} /> {away} new message{away > 1 ? "s" : ""}
                </button>
              )}
            </div>

            {/* ------------------------------------------------ composer */}
            <footer className="border-t border-line-soft bg-surface px-3 py-3 sm:px-4">
              {wallRef && !current.opted_out && (
                <p className="mb-2 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
                  <b>Seva wall:</b> the brick picture and thank-you are ready below. Check them and press Send - the brick is then marked &quot;WhatsApp sent&quot;.

                </p>
              )}
              {current.opted_out ? (
                <Alert tone="warn">This donor wrote STOP. DRM will not message them until they write START.</Alert>
              ) : !showTpl ? (
                <div className="space-y-2">
                  {!replied && (
                    <p className="text-xs text-amber-700">
                      No reply from this person in the last 24 hours. WhatsApp may refuse a normal message - if it does, the message shows why and you can send a template (📋).
                    </p>
                  )}
                  {file && (
                    <div className="flex items-center gap-3 rounded-xl border border-line-soft bg-sunken p-2.5">
                      {file.preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={file.preview} alt="" className="h-16 w-16 rounded-lg object-cover" /> : <span className="grid h-16 w-16 place-items-center rounded-lg bg-white text-brand-700"><Icon name="file" size={26} /></span>}
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{file.name}</p><p className="text-xs text-ink-faint">{Math.max(1, Math.round(file.size / 1024))} KB · add a caption below if you like</p></div>
                      <Button size="xs" variant="ghost" onClick={() => setFile(null)}>Remove</Button>
                    </div>
                  )}
                  {quickOpen && (
                    <div className="max-h-48 space-y-1 overflow-y-auto rounded-xl border border-line-soft bg-surface p-2 shadow-md">
                      {QUICK_REPLIES.map((r) => (
                        <button key={r} className="block w-full rounded-lg px-3 py-2 text-left text-sm text-ink-soft hover:bg-brand-50" onClick={() => { setDraft(r); setQuickOpen(false); }}>{r}</button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-end gap-2">
                    <input ref={fileInput} type="file" accept={ACCEPT} className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
                    <button type="button" onClick={() => fileInput.current?.click()} aria-label="Attach a picture or file" title="Attach a picture or file" className="grid h-10 w-10 flex-none place-items-center rounded-full text-ink-muted hover:bg-sunken hover:text-ink"><Paperclip /></button>
                    <button type="button" onClick={() => setShowTpl(true)} aria-label="Send a template" title="Send an approved template" className="grid h-10 w-10 flex-none place-items-center rounded-full text-ink-muted hover:bg-sunken hover:text-ink"><Icon name="fileText" size={18} /></button>
                    <button type="button" onClick={() => setQuickOpen((v) => !v)} aria-label="Quick replies" title="Quick replies" className={`grid h-10 w-10 flex-none place-items-center rounded-full hover:bg-sunken ${quickOpen ? "bg-brand-50 text-brand-700" : "text-ink-muted hover:text-ink"}`}><Icon name="sparkle" size={18} /></button>
                    <Textarea
                      rows={Math.min(8, Math.max(1, draft.split("\n").length))}
                      value={draft}
                      maxLength={file ? 1024 : 4096}
                      onChange={(e) => setDraft(e.target.value)}
                      onPaste={(e) => { const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/")); if (f) { e.preventDefault(); pickFile(f); } }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          if (file) void sendFile();
                          else if (draft.trim()) void sendText(draft);
                        }
                      }}
                      placeholder={file ? "Add a caption" : "Type a message"}
                      title="Enter to send · Shift+Enter for a new line · paste or drop a picture to attach it"
                      className="max-h-56 min-h-10 flex-1 resize-none !rounded-2xl !px-4 !py-2.5"
                    />
                    <button type="button" aria-label="Send" disabled={sending || (!file && !draft.trim())} onClick={() => void (file ? sendFile() : sendText(draft))}
                      className="grid h-10 w-10 flex-none place-items-center rounded-full bg-[#25D366] text-white shadow transition hover:bg-[#1da851] disabled:opacity-40">
                      {sending ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> : <SendIcon />}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">Send an approved template <span className="font-normal text-ink-muted">- reaches anyone, any time; a 📷 one carries a picture</span></p>
                    <Button size="xs" variant="ghost" icon="arrowLeft" onClick={() => setShowTpl(false)}>Back to message</Button>
                  </div>
                  {templates === null ? <Skeleton className="h-9 w-full" /> : templates.length === 0 ? (
                    <p className="text-sm text-ink-muted">No approved text templates are available.</p>
                  ) : (
                    <div className="space-y-2">
                      <select className="h-10 w-full rounded-control border border-line-strong bg-surface px-3 text-sm" value={tplName} onChange={(e) => { setTplName(e.target.value); setTplParams([]); if (!wallRef) setFile(null); }}>
                        <option value="">Choose a template…</option>
                        {templates.map((t) => <option key={t.name} value={t.name}>{t.header === "IMAGE" ? "📷 " : t.header ? "📎 " : ""}{t.name}</option>)}
                      </select>
                      {tpl && (
                        <>
                          {Array.from({ length: tpl.paramCount }, (_v, i) => (
                            <Input key={i} placeholder={`Value for {{${i + 1}}}`} value={tplParams[i] ?? ""} onChange={(e) => setTplParams((p) => { const n = [...p]; n[i] = e.target.value; return n; })} />
                          ))}
                          {tpl.header && (
                            <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-sunken p-2.5">
                              <input ref={tplFileInput} type="file" accept={HEADER_ACCEPT[tpl.header]} className="hidden" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
                              {file?.preview ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={file.preview} alt="" className="h-16 w-16 rounded-lg object-cover" /> : <span className="grid h-16 w-16 flex-none place-items-center rounded-lg bg-white text-brand-700"><Icon name="file" size={24} /></span>}
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium">{file ? file.name : `This template carries a ${tpl.header.toLowerCase()}`}</p>
                                <p className="text-xs text-ink-faint">{file ? `${Math.max(1, Math.round(file.size / 1024))} KB` : "Attach it to send the message"}</p>
                              </div>
                              <Button size="sm" variant="secondary" icon="upload" onClick={() => tplFileInput.current?.click()}>{file ? "Change" : `Attach ${tpl.header.toLowerCase()}`}</Button>
                            </div>
                          )}
                          <p className="whitespace-pre-wrap rounded-xl bg-[#d9fdd3]/60 p-3 text-sm text-ink-soft">{tplPreview}</p>
                          <Button variant="whatsapp" loading={sending} disabled={Array.from({ length: tpl.paramCount }, (_v, i) => (tplParams[i] ?? "").trim()).some((v) => !v) || (!!tpl.header && !file)} onClick={() => void sendTemplate()}>Send {tpl.header ? "with picture" : "message"}</Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </footer>
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-brand-500 bg-brand-50/80">
                <p className="text-sm font-semibold text-brand-800">Drop the picture or file to attach it</p>
              </div>
            )}
          </>
        )}
      </section>

      {lightbox && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4" onClick={() => setLightbox(null)} role="dialog" aria-modal>
          <button className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25" aria-label="Close"><Icon name="x" size={20} /></button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={lightbox} alt="Picture" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </div>
  );
}

export default function WhatsAppPage() {
  return (
    <Suspense fallback={null}>
      <ChatInner />
    </Suspense>
  );
}
