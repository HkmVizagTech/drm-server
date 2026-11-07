"use client";

// How many WhatsApp chats are waiting for an answer, for the badge in the menu and in the phone's bottom
// bar. One shared poll for every place that shows it (every 30 seconds, only while the tab is visible),
// so a second badge never means a second request.

import { useSyncExternalStore } from "react";
import { apiClient } from "@/lib/api";

let count = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

async function ask() {
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  try {
    const r = await apiClient.get<{ chats: number }>("/api/wa-chat/unread-count");
    if (r.chats !== count) {
      count = r.chats;
      listeners.forEach((l) => l());
    }
  } catch {
    /* the next beat tries again */
  }
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (!timer) {
    void ask();
    timer = setInterval(() => void ask(), 30000);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The count, or 0 for anyone who cannot open the chat. */
export function useWhatsAppUnread(role: string | undefined): number {
  const n = useSyncExternalStore(subscribe, () => count, () => 0);
  return role === "admin" || role === "caller" ? n : 0;
}
