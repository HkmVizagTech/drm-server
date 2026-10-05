"use client";

// News that has to interrupt a call run: a lead who just donated, and a
// promise that has come due.
//
// On this screen they cannot live only in the bell in the corner. A caller
// mid-run is looking at the outcome buttons, not the header, and a reminder
// scrolled past is a promise broken. Both come from the one shared poll in
// CallingAlertsProvider, so the bell and this screen never disagree.

import Link from "next/link";
import { apiClient } from "@/lib/api";
import { currency } from "@/lib/format";
import { callHref, formatPhone } from "@/lib/calling";
import { Alert, Button, Icon, buttonClass } from "@/components/ui";
import { toast } from "@/components/toast";
import { useCallingAlerts } from "@/components/calling-alerts";

export function CallBanners({ back }: { back: string }) {
  const { alerts, conversions, dueCount, dismissAlert, dismissConversions } = useCallingAlerts();

  async function act(id: string, body: Record<string, unknown>, done: string) {
    try {
      await apiClient.put(`/api/crm/reminders/${id}`, body);
      dismissAlert(id);
      toast(done);
    } catch (e) {
      toast.error("Could not update. Try again.", e instanceof Error ? e.message : undefined);
    }
  }

  return (
    <>
      {conversions.map((c) => (
        <Alert key={c.id} tone="good">
          <p>
            <span className="font-semibold">{c.name || formatPhone(c.phone)}</span> donated
            {c.converted_amount ? <> {currency(Number(c.converted_amount))}</> : null}
            {c.purpose ? <span> · {c.purpose}</span> : null}
            <span className="opacity-80"> · {c.converted_via === "auto" ? "online" : "added by hand"}</span>
          </p>
          {/* Under the sentence, not beside it: at phone width a row of
              actions next to two lines of text has nowhere to go but off the
              side of the screen. */}
          <div className="mt-2 flex flex-wrap gap-2">
            <Link href={`/leads/${c.id}`} className={buttonClass("primary", "md")}>
              Open
            </Link>
            <Button variant="secondary" onClick={() => void dismissConversions([c.id])}>
              Got it
            </Button>
          </div>
        </Alert>
      ))}

      {alerts.map((a) => (
        <Alert
          key={a.id + a.due_at}
          tone="warn"
          title={a.occasion ? `${a.lead_name || formatPhone(a.lead_phone)} · ${a.occasion}` : a.lead_name || formatPhone(a.lead_phone)}
        >
          <p>{a.title}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {/* Through the call screen, so the outcome is logged against them
                rather than lost to a bare dialler. `back` returns here. */}
            <Link href={callHref(a.lead_id, back)} className={buttonClass("primary", "md")}>
              <Icon name="phone" size={15} />
              Call {formatPhone(a.lead_phone)}
            </Link>
            <Button
              variant="secondary"
              onClick={() => void act(a.id, { action: "snooze", minutes: 60 }, "Moved to 1 hour from now")}
            >
              In an hour
            </Button>
            <Button variant="secondary" icon="check" onClick={() => void act(a.id, { action: "done" }, "Reminder done")}>
              Done
            </Button>
          </div>
        </Alert>
      ))}

      {/* Nothing has fired yet, but something is owed today. Quieter than an
          alert because it is not interrupting - just refusing to let a caller
          finish a run unaware that a promise falls due. */}
      {!alerts.length && dueCount > 0 && (
        <Alert tone="info">
          <Link href="/calling/reminders" className="flex min-h-6 items-center justify-between gap-3">
            <span>
              {dueCount} promise{dueCount === 1 ? "" : "s"} due
            </span>
            <span className="inline-flex flex-none items-center gap-1 font-medium">
              See them
              <Icon name="arrowRight" size={13} />
            </span>
          </Link>
        </Alert>
      )}
    </>
  );
}
