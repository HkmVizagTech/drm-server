"use client";

// Filters that survive a refresh.
//
// A caller who picked "Mine" on Follow-ups, refreshed, and found "All" again had to set it every time.
// Each screen's filters are now kept for the browser tab (sessionStorage): a refresh keeps them, clearing
// a filter clears it, closing the tab or signing out forgets them. A filter back at its default is not
// stored at all, so "Clear filters" leaves nothing behind.
//
// Built on useSyncExternalStore: the server and the first paint render the default, the stored value
// follows straight after, so there is no hydration mismatch. If the browser blocks storage the screen
// still works - the filters just are not remembered.

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";

const PREFIX = "drm.filters:";
const memory = new Map<string, string | null>();
const listeners = new Map<string, Set<() => void>>();

function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  let v: string | null = null;
  try {
    v = sessionStorage.getItem(PREFIX + key);
  } catch {
    v = null;
  }
  memory.set(key, v);
  return v;
}

function write(key: string, v: string | null) {
  memory.set(key, v);
  try {
    if (v === null) sessionStorage.removeItem(PREFIX + key);
    else sessionStorage.setItem(PREFIX + key, v);
  } catch {
    /* storage blocked: kept in memory for this page only */
  }
  listeners.get(key)?.forEach((l) => l());
}

function parse<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Put a value in place before a screen reads it (a link that arrives with its own filter). */
export function seedSessionState<T>(key: string, value: T) {
  write(key, JSON.stringify(value));
}

/** Forget every saved filter - on sign-out, so the next person starts clean. */
export function clearSavedFilters() {
  memory.clear();
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(PREFIX)) sessionStorage.removeItem(k);
    }
  } catch {
    /* nothing to clear */
  }
  listeners.forEach((set) => set.forEach((l) => l()));
}

/** useState that the browser tab remembers across a refresh. `key` must be unique per screen and filter. */
export function useSessionState<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [initialValue] = useState(initial);
  const subscribe = useCallback(
    (l: () => void) => {
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(l);
      return () => {
        set!.delete(l);
      };
    },
    [key]
  );
  const raw = useSyncExternalStore(subscribe, () => read(key), () => null);
  const value = useMemo(() => parse(raw, initialValue), [raw, initialValue]);
  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      const cur = parse(read(key), initialValue);
      const v = typeof next === "function" ? (next as (prev: T) => T)(cur) : next;
      const s = JSON.stringify(v);
      write(key, s === JSON.stringify(initialValue) ? null : s);
    },
    [key, initialValue]
  );
  return [value, set];
}
