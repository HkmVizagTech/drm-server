"use client";

import { useRouter } from "next/navigation";
import { LeadForm } from "@/components/devotee/lead-form";
import { toast } from "@/components/toast";
import { useDevotee } from "@/lib/devotee-context";

export default function NewDevoteeLeadPage() {
  const router = useRouter();
  const { config } = useDevotee();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight text-ink">Add lead</h1>
      <p className="mb-5 text-sm text-ink-muted">Save who you met. Only you will see this lead.</p>
      <LeadForm
        config={config}
        onCancel={() => router.back()}
        onSaved={(lead) => {
          toast.success(`${lead.name} added`);
          router.replace(`/devotee/leads/${lead.id}`);
        }}
      />
    </div>
  );
}
