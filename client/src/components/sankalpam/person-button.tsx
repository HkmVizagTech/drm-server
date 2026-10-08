"use client";

// "Add to Sankalpam" on a person's page - for anyone, whatever they have
// given. Adding opens their Sankalpam entry with every day DRM already knows
// for them, ready for the rest to be typed in. Someone already on the list
// gets "In Sankalpam" instead, which opens that entry.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiClient } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { toast } from "@/components/toast";
import { Button } from "@/components/ui";

export function SankalpamPersonButton({ personId }: { personId: string }) {
  const { user } = useAuth();
  const router = useRouter();
  const allowed = user?.role === "admin" || user?.role === "caller";
  const [state, setState] = useState<{ id: string; days: number } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    let live = true;
    apiClient
      .get<{ donor: { id: string; days: number } | null }>(`/api/sankalpam/by-person/${personId}`)
      .then((r) => live && setState(r.donor))
      .catch(() => live && setState(null));
    return () => {
      live = false;
    };
  }, [personId, allowed]);

  if (!allowed || state === undefined) return null;

  const open = (id: string) => router.push(`/sankalpam?tab=donors&edit=${id}`);

  if (state) {
    return (
      <Button variant="secondary" icon="sparkle" onClick={() => open(state.id)}>
        In Sankalpam{state.days ? ` · ${state.days} day${state.days === 1 ? "" : "s"}` : " · no days yet"}
      </Button>
    );
  }
  return (
    <Button
      variant="secondary"
      icon="sparkle"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await apiClient.post<{ id: string; days: number; existing: boolean }>(`/api/sankalpam/from-person/${personId}`, {});
          toast(r.days ? `Added to Sankalpam with ${r.days} special day${r.days === 1 ? "" : "s"}` : "Added to Sankalpam - add their special days");
          open(r.id);
        } catch (e) {
          toast.error("Could not add. Try again.", e instanceof Error ? e.message : undefined);
          setBusy(false);
        }
      }}
    >
      Add to Sankalpam
    </Button>
  );
}
