"use client";

// "This phone" - setting the DRM app up on a caller's phone, and checking it
// is working. Only reachable inside the app (the nav hides it elsewhere).
//
// The checks, in the order a caller does them:
//   1. allow calls and the call log      -> calls and call-backs are saved
//   2. allow music and audio (recordings) -> recordings can be found
//   3. turn on auto-record in the phone's own dialer
//   4. let the app run in the background  -> call-backs saved with DRM closed
//   5. find a recording                   -> proof the app can see them

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { dateTime, relativeDate } from "@/lib/format";
import {
  dialerHidesRecordings,
  phone,
  useInApp,
  type FoundRecording,
  type PhoneInfo,
} from "@/lib/phone-app";
import { Alert, Badge, Button, Card, CardHeader, LinkButton, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { toast } from "@/components/toast";

/** Where each maker hides "record calls automatically". */
function autoRecordSteps(manufacturer: string): string {
  const m = manufacturer.toLowerCase();
  if (m.includes("samsung")) return "Phone app → ⋮ → Settings → Record calls → turn on Auto record calls → All calls.";
  if (m.includes("xiaomi") || m.includes("redmi") || m.includes("poco"))
    return "Phone app → ⋮ → Settings → Call recording → turn on Record calls automatically → All numbers.";
  if (m.includes("vivo") || m.includes("iqoo")) return "Phone app → Settings → Call recording → Auto record calls → All calls.";
  if (m.includes("oppo") || m.includes("realme") || m.includes("oneplus"))
    return "Phone app → ⋮ → Settings → Call recording → Auto record calls → All calls.";
  return "Open the Phone app's settings, find Call recording, and turn on automatic recording for all calls.";
}

function Step({
  done,
  title,
  children,
  action,
}: {
  done: boolean | null;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex gap-3 border-b border-line-soft py-3.5 last:border-0">
      <span
        className={`mt-0.5 grid h-6 w-6 flex-none place-items-center rounded-full ${
          done === null ? "bg-sunken text-ink-faint" : done ? "bg-good-wash text-good" : "bg-warn-wash text-warn"
        }`}
      >
        <Icon name={done ? "check" : done === null ? "info" : "alert"} size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-ink">{title}</p>
        {children && <div className="mt-0.5 text-sm text-ink-muted">{children}</div>}
        {action && <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
      </div>
    </li>
  );
}

export default function ThisPhonePage() {
  const app = useInApp();
  const { user } = useAuth();
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [found, setFound] = useState<FoundRecording | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const p = phone();
    if (!p) return;
    p.getInfo()
      .then(setInfo)
      .catch(() => undefined);
  }, []);

  // Again whenever the caller comes back from the phone's settings.
  useEffect(() => {
    if (!app) return;
    refresh();
    const onShow = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [app, refresh]);

  async function run(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work. Try again.");
    } finally {
      setBusy(null);
      refresh();
    }
  }

  if (!app) {
    return (
      <>
        <PageHeader title="This phone" subtitle="Setting up the DRM app on a caller's phone." />
        <Alert tone="info" title="Open this in the DRM app">
          This screen is for the DRM Android app. Install it on the caller&apos;s phone, sign in, and open This phone from
          the menu.
        </Alert>
      </>
    );
  }

  const p = info?.permissions ?? {};
  const calls = !!(p.call && p.call_log && p.phone_state);
  const recordings = !!(p.audio || p.all_files);
  const googleDialer = dialerHidesRecordings(info?.dialer);

  return (
    <>
      <PageHeader
        title="This phone"
        subtitle="So that every call - the ones you make and the ones that ring back - is saved in DRM with its recording."
        actions={
          <>
          <LinkButton href="/calling/recordings" variant="secondary" icon="mic">
            My recordings
          </LinkButton>
          <Button
            icon="refresh"
            variant="secondary"
            loading={busy === "sync"}
            onClick={() =>
              void run("sync", async () => {
                const r = await phone()!.syncNow();
                if (r.error) toast.warn(r.error);
                else toast.success("Calls sent to DRM.");
              })
            }
          >
            Send calls now
          </Button>
          </>
        }
      />

      {googleDialer && (
        <Alert tone="warn" title="This phone uses the Google Phone app">
          Google&apos;s Phone app keeps its recordings to itself, so DRM cannot get them on this phone. Calls, call-backs
          and talk time are still saved. For recordings, use a phone with its maker&apos;s own dialer (most Samsung,
          Vivo, Oppo and Realme phones).
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card>
          <CardHeader title="Set up" icon="settings" />
          <ol>
            <Step
              done={calls}
              title="Make calls and read the call log"
              action={
                !calls && (
                  <Button size="sm" loading={busy === "perm"} onClick={() => void run("perm", () => phone()!.requestPermissions())}>
                    Allow
                  </Button>
                )
              }
            >
              Lets the Call buttons ring from your SIM, and lets the app see which calls happened. Only calls with DRM&apos;s
              donors are sent - your personal calls stay on your phone.
            </Step>
            <Step
              done={recordings}
              title="Read call recordings"
              action={
                !recordings && (
                  <Button size="sm" loading={busy === "perm2"} onClick={() => void run("perm2", () => phone()!.requestPermissions())}>
                    Allow music and audio
                  </Button>
                )
              }
            >
              The app looks for the recording your phone made of each call with a donor, and sends only that one.
            </Step>
            <Step done={null} title="Turn on automatic call recording">
              {googleDialer ? "Not possible with the Google Phone app (see above)." : autoRecordSteps(info?.manufacturer ?? "")}
            </Step>
            <Step
              done={!!p.battery}
              title="Let the app work in the background"
              action={
                !p.battery && (
                  <Button size="sm" variant="secondary" onClick={() => void run("battery", () => phone()!.openBatterySettings())}>
                    Allow
                  </Button>
                )
              }
            >
              So a donor who rings you back at night is saved even when DRM is closed.
            </Step>
            <Step
              done={found ? found.found : null}
              title="Check the app can see your recordings"
              action={
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon="search"
                    loading={busy === "find"}
                    onClick={() => void run("find", async () => setFound(await phone()!.findRecording()))}
                  >
                    Find a recording
                  </Button>
                  {found && !found.found && !p.all_files && (
                    <Button size="sm" variant="secondary" onClick={() => void run("files", () => phone()!.openAllFilesSettings())}>
                      Allow all files
                    </Button>
                  )}
                </>
              }
            >
              {!found && "Make one short test call first, then press Find a recording."}
              {found?.found && (
                <>
                  Found <span className="font-medium text-ink">{found.name}</span> in {found.folder || "the phone"},{" "}
                  {relativeDate(new Date(found.modifiedAt ?? 0).toISOString())}.
                </>
              )}
              {found && !found.found && (
                <>
                  No call recording from the last week was found. Check automatic recording is on and make a test call.
                  {!p.all_files && " Some phones also need Allow all files."}
                </>
              )}
            </Step>
          </ol>
        </Card>

        <Card>
          <CardHeader title="Status" icon="info" />
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Linked to</dt>
              <dd className="text-right font-medium text-ink">{info?.linked ? user?.name : <Badge tone="warn">Not linked</Badge>}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Phone</dt>
              <dd className="text-right text-ink">
                {info ? `${info.manufacturer} ${info.model} · Android ${info.androidVersion}` : "…"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">App</dt>
              <dd className="text-right text-ink">{info?.appVersion ?? "…"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Last sent</dt>
              <dd className="text-right text-ink">
                {info?.lastSyncAt ? dateTime(new Date(info.lastSyncAt).toISOString()) : "Not yet"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Recordings waiting</dt>
              <dd className="text-right text-ink">{info?.pendingRecordings ?? 0}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Recordings folder</dt>
              <dd className="text-right text-ink">{info?.recordingsFolder ?? "Not found yet"}</dd>
            </div>
          </dl>
          {info?.lastError && (
            <Alert tone="warn" className="mt-4 mb-0">
              {info.lastError}
            </Alert>
          )}
        </Card>
      </div>
    </>
  );
}
