"use client";

// Put DRM's own donors on the Sankalpam list: everyone who has given at least
// an amount, in total or in one donation. Whatever special days DRM already
// knows for them (a birthday they typed on the site's form, the day a seva
// was booked for) come with them; the rest land on "Need details" to be rung.
// Safe to run again - only donors not on the list yet are added.

import { useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import { currency, number, relativeDate } from "@/lib/format";
import { toast } from "@/components/toast";
import { Alert, Button, Field, Input, Modal, SegmentedControl, Skeleton } from "@/components/ui";

interface Preview {
  qualifying: number;
  already: number;
  to_add: number;
  with_days: number;
  sample: { person_id: string; name: string; phone: string; total: string; biggest: string; donations: number; last_at: string; has_days: boolean }[];
}

export function AddDonorsDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void | Promise<void> }) {
  const [min, setMin] = useState("5000");
  const [basis, setBasis] = useState<"total" | "single">("total");
  const [site, setSite] = useState<"all" | "hkmv" | "annadan">("all");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = Number(min) || 0;
  useEffect(() => {
    if (amount < 1) return;
    let live = true;
    const t = window.setTimeout(() => {
      apiClient
        .get<Preview>(`/api/sankalpam/candidates?min=${amount}&basis=${basis}&site=${site}`)
        .then((p) => {
          if (!live) return;
          setPreview(p);
          setError(null);
        })
        .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load."));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [amount, basis, site]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const r = await apiClient.post<{ added: number; linked: number; days: number }>("/api/sankalpam/add-donors", {
        min: amount,
        basis,
        site,
      });
      toast(`Added ${number(r.added)} donor${r.added === 1 ? "" : "s"} with ${number(r.days)} special day${r.days === 1 ? "" : "s"}`);
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add. Try again.");
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add donors to Sankalpam"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!preview || preview.to_add === 0} onClick={() => void add()}>
            {preview ? `Add ${number(preview.to_add)} donor${preview.to_add === 1 ? "" : "s"}` : "Add"}
          </Button>
        </>
      }
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Given at least (₹)" htmlFor="ad-min">
          <Input id="ad-min" value={min} inputMode="numeric" className="tabular-nums" onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} />
        </Field>
        <Field label="Counted as">
          <SegmentedControl
            value={basis}
            onChange={(v) => setBasis(v as "total" | "single")}
            options={[
              { value: "total", label: "In total" },
              { value: "single", label: "In one donation" },
            ]}
          />
        </Field>
        <Field label="Site">
          <SegmentedControl
            value={site}
            onChange={(v) => setSite(v as "all" | "hkmv" | "annadan")}
            options={[
              { value: "all", label: "Both" },
              { value: "hkmv", label: "HKM Vizag" },
              { value: "annadan", label: "Annadan" },
            ]}
          />
        </Field>
      </div>

      {!preview ? (
        <Skeleton className="mt-4 h-40" />
      ) : (
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Will be added" value={preview.to_add} strong />
            <Stat label="Have days already" value={preview.with_days} />
            <Stat label="Already on the list" value={preview.already} />
          </div>
          <p className="text-sm text-ink-soft">
            Days they gave on the donation form come with them. The other{" "}
            {number(Math.max(0, preview.to_add - preview.with_days))} go to <b>Need details</b> to be rung. Days they fill in on the
            site later are added by themselves.
          </p>
          {preview.sample.length > 0 && (
            <ul className="max-h-72 divide-y divide-line-soft overflow-y-auto rounded-card border border-line-soft">
              {preview.sample.map((r) => (
                <li key={r.person_id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-ink">{r.name}</span>
                    <span className="block text-xs tabular-nums text-ink-muted">
                      {r.phone} · {r.donations} donation{r.donations === 1 ? "" : "s"} · last {relativeDate(r.last_at).toLowerCase()}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block font-semibold tabular-nums text-ink">{currency(Number(r.total))}</span>
                    <span className={`block text-2xs ${r.has_days ? "text-good" : "text-warn"}`}>{r.has_days ? "Has a day" : "Needs a call"}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {preview.to_add > preview.sample.length && (
            <p className="text-xs text-ink-muted">Showing the top {preview.sample.length} by amount.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-card border border-line-soft bg-surface px-3 py-2.5">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`text-2xl font-semibold tabular-nums ${strong ? "text-brand-700" : "text-ink"}`}>{number(value)}</p>
    </div>
  );
}
