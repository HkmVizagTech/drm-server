"use client";

// Choosing the seva a receipt is for, from DRM's seva list.
//
// The main site's DCC call expects a Seva Code, so for HKM Vizag receipts the seva
// is picked, not typed: Seva category, then the seva (its code shown beside it),
// then - where the seva has them - the sub seva. What is stored and sent is the
// catalog id of the row picked; the server looks the code up itself.
//
// If the list cannot be loaded, or is empty, the form falls back to the old typed
// seva rather than stopping anyone raising a receipt.

import { useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { Select } from "@/components/ui";

export interface CatalogSeva {
  id: string;
  category: string;
  categoryId: number;
  code: string;
  subCategory: string;
  subCategoryId: number;
  subCode: string | null;
  subCodeId: number | null;
  name: string;
  /** "HKMI" or "TSC": which DCC account the seva belongs to (4 or 5). */
  accountType?: string;
}

// One fetch shared by every form on the page; a form opened a second time does not wait again.
let cache: Promise<CatalogSeva[]> | null = null;
// Whether the list loaded with something in it. Read by the form's validation, which
// is a plain function with no way to ask the component.
let available = false;

/** True once the seva list has loaded and has sevas in it: only then is picking one required. */
export const sevaListAvailable = () => available;

function load(): Promise<CatalogSeva[]> {
  if (!cache) {
    cache = apiClient
      .get<{ sevas: CatalogSeva[] }>("/api/seva-catalog?active=true")
      .then((r) => {
        available = r.sevas.length > 0;
        return r.sevas;
      })
      .catch(() => {
        cache = null; // try again next time
        return [];
      });
  }
  return cache;
}

export function useSevaCatalog() {
  const [sevas, setSevas] = useState<CatalogSeva[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void load().then((s) => {
      if (live) {
        setSevas(s);
        setReady(true);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  return { sevas, ready };
}

export function SevaPicker({
  value,
  onChange,
  invalid = false,
  account = "HKMI",
}: {
  /** Which account's sevas to offer. TSC has a short flat list; HKMI has categories and sub sevas. */
  account?: "HKMI" | "TSC";
  /** The catalog id picked, or "". */
  value: string;
  /** The id and the name to show/print, or "" and "" when cleared. */
  onChange: (id: string, name: string) => void;
  invalid?: boolean;
}) {
  const { sevas: all, ready } = useSevaCatalog();
  const sevas = useMemo(() => all.filter((s) => (s.accountType ?? "HKMI") === account), [all, account]);
  const picked = useMemo(() => sevas.find((s) => s.id === value) ?? null, [sevas, value]);
  const [category, setCategory] = useState("");
  const [subCategory, setSubCategory] = useState("");

  // A value set from outside (a form reopened with what was saved) selects its parents.
  useEffect(() => {
    if (picked) {
      setCategory(String(picked.categoryId));
      setSubCategory(String(picked.subCategoryId));
    }
  }, [picked]);

  const categories = useMemo(() => {
    const seen = new Map<number, string>();
    for (const s of sevas) if (!seen.has(s.categoryId)) seen.set(s.categoryId, s.category);
    return [...seen].map(([id, name]) => ({ id, name }));
  }, [sevas]);

  const subCategories = useMemo(() => {
    const seen = new Map<number, CatalogSeva>();
    for (const s of sevas) if (String(s.categoryId) === category && !seen.has(s.subCategoryId)) seen.set(s.subCategoryId, s);
    return [...seen.values()];
  }, [sevas, category]);

  const subs = useMemo(
    () => sevas.filter((s) => String(s.subCategoryId) === subCategory && s.subCode),
    [sevas, subCategory]
  );

  if (!ready) return <p className="text-sm text-ink-muted">Loading sevas…</p>;
  if (!sevas.length) return null; // the form shows its typed field instead

  // TSC: one drop-down, each seva with its code in brackets - "Subhojanam (ANBJ)".
  if (account === "TSC") {
    return (
      <Select
        value={picked?.id ?? ""}
        onChange={(id) => {
          const s = sevas.find((x) => x.id === id);
          onChange(s?.id ?? "", s?.name ?? "");
        }}
        placeholder="Seva…"
        ariaLabel="TSC seva"
        className={invalid ? "rounded-control ring-2 ring-danger/40" : ""}
      >
        {sevas.map((s) => (
          <option key={s.id} value={s.id}>
            {`${s.subCategory} (${s.code})`}
          </option>
        ))}
      </Select>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Select
        value={category}
        onChange={(v) => {
          setCategory(v);
          setSubCategory("");
          onChange("", "");
        }}
        placeholder="Seva category…"
        ariaLabel="Seva category"
        className={invalid ? "rounded-control ring-2 ring-danger/40" : ""}
      >
        {categories.map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        value={subCategory}
        onChange={(v) => {
          setSubCategory(v);
          const rows = sevas.filter((s) => String(s.subCategoryId) === v);
          // A seva with no sub sevas is the row itself: picked as soon as it is chosen.
          if (rows.length === 1 && !rows[0].subCode) onChange(rows[0].id, rows[0].name);
          else onChange("", "");
        }}
        placeholder={category ? "Seva…" : "Pick a category first"}
        disabled={!category}
        ariaLabel="Seva"
        className={invalid ? "rounded-control ring-2 ring-danger/40" : ""}
      >
        {subCategories.map((s) => (
          <option key={s.subCategoryId} value={String(s.subCategoryId)}>
            {`${s.subCategory} (${s.code})`}
          </option>
        ))}
      </Select>
      {subs.length > 0 && (
        <div className="sm:col-span-2">
          <Select
            value={picked?.subCode ? picked.id : ""}
            onChange={(id) => {
              const s = sevas.find((x) => x.id === id);
              onChange(s?.id ?? "", s?.name ?? "");
            }}
            placeholder="Sub seva…"
            ariaLabel="Sub seva"
            className={invalid ? "rounded-control ring-2 ring-danger/40" : ""}
          >
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.subCode}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
