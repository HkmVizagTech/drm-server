"use client";

// The devotee's leads on a map, to plan a day of visits: see who lives near whom, find the
// nearest from where you stand, tick the ones to visit and open the whole trip in Google Maps.

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import { useDevotee } from "@/lib/devotee-context";
import { currentPosition, type LatLngLiteral } from "@/lib/google-maps";
import { STATUS, STATUS_ORDER, addressLine, directionsHref, distanceKm, routeHref, type LeadStatus } from "@/lib/devotee";
import { Alert, Button, Card, EmptyState, LinkButton, Skeleton } from "@/components/ui";
import { Icon } from "@/components/icons";
import { LeadStatusBadge } from "@/components/devotee/lead-bits";
import { LeadsMap, PIN, type MapLead } from "@/components/devotee/leads-map";

const MAX_STOPS = 10;

/** Visit order: from where you are, always on to the nearest one not yet visited. */
function nearestFirst(from: LatLngLiteral | null, stops: MapLead[]): MapLead[] {
  if (!from) return stops;
  const left = [...stops];
  const out: MapLead[] = [];
  let at = from;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++) {
      if (distanceKm(at, { lat: left[i].latitude, lng: left[i].longitude }) < distanceKm(at, { lat: left[best].latitude, lng: left[best].longitude })) best = i;
    }
    const [next] = left.splice(best, 1);
    out.push(next);
    at = { lat: next.latitude, lng: next.longitude };
  }
  return out;
}

function MapScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const { config } = useDevotee();
  const [data, setData] = useState<{ rows: MapLead[]; without_location: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<LeadStatus>>(() => new Set(["invalid_number", "not_interested"]));
  const [me, setMe] = useState<LatLngLiteral | null>(null);
  const [locating, setLocating] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [focus, setFocus] = useState<string | null>(() => params.get("focus"));

  useEffect(() => {
    apiClient
      .get<{ rows: MapLead[]; without_location: number }>("/api/devotee/leads/map")
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function locate() {
    setLocating(true);
    try {
      setMe(await currentPosition());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLocating(false);
    }
  }

  const shown = useMemo(() => (data?.rows ?? []).filter((l) => !hidden.has(l.status)), [data, hidden]);
  const listed = useMemo(() => {
    if (!me) return shown;
    return [...shown].sort(
      (a, b) => distanceKm(me, { lat: a.latitude, lng: a.longitude }) - distanceKm(me, { lat: b.latitude, lng: b.longitude })
    );
  }, [shown, me]);

  const trip = useMemo(() => nearestFirst(me, (data?.rows ?? []).filter((l) => picked.includes(l.id))), [data, picked, me]);
  const tripHref = routeHref(trip);

  const toggleStatus = (s: LeadStatus) =>
    setHidden((h) => {
      const n = new Set(h);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  const togglePick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_STOPS ? p : [...p, id]));

  if (!config || (!data && !error)) {
    return <Skeleton className="h-[60vh] w-full" rounded="rounded-panel" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Map</h1>
          <p className="text-sm text-ink-muted">Your leads by location. Tick a few to plan a visit route.</p>
        </div>
        <Button variant="secondary" icon="locate" loading={locating} onClick={() => void locate()}>
          {me ? "Update my location" : "Nearest to me"}
        </Button>
      </div>

      {error && <Alert tone="danger" onDismiss={() => setError(null)}>{error}</Alert>}
      {data && data.without_location > 0 && (
        <Alert tone="info">
          {data.without_location} lead{data.without_location === 1 ? " has" : "s have"} no location yet. Open a lead and use “Use my current location” when you visit, or “Find address on map”.
        </Alert>
      )}

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div className="flex w-max gap-1.5">
          {STATUS_ORDER.map((s) => {
            const on = !hidden.has(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-xs font-medium ring-1 ring-inset ${on ? "bg-surface text-ink ring-line" : "bg-sunken text-ink-faint ring-line-soft line-through"}`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: PIN[s] }} aria-hidden />
                {STATUS[s].label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        {config.maps_key ? (
          <LeadsMap
            leads={shown}
            config={config}
            me={me}
            focusId={focus}
            onOpen={(id) => router.push(`/devotee/leads/${id}`)}
            className="h-[55vh] min-h-80 lg:h-[calc(100vh-15rem)]"
          />
        ) : (
          <Card>
            <EmptyState
              icon="mapPin"
              title="Map view is not set up yet"
              message="The temple office needs to add a Google Maps key. Until then, use the list to get directions and plan routes - those open in Google Maps."
            />
          </Card>
        )}

        <div className="space-y-3">
          {picked.length > 0 && (
            <Card tone="brand">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-ink">
                  {picked.length} stop{picked.length === 1 ? "" : "s"} picked{picked.length >= MAX_STOPS ? " (most allowed)" : ""}
                </p>
                <button type="button" className="text-xs text-ink-muted hover:text-ink" onClick={() => setPicked([])}>
                  Clear
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-muted">{me ? "In the order nearest to you." : "Tap “Nearest to me” to order the stops from where you are."}</p>
              {tripHref && (
                <LinkButton href={tripHref} target="_blank" rel="noreferrer" icon="route" className="mt-3 w-full justify-center">
                  Start route in Google Maps
                </LinkButton>
              )}
            </Card>
          )}

          {listed.length === 0 ? (
            <Card>
              <EmptyState icon="mapPin" title="No leads on the map" message="Leads appear here once they have a location pinned." />
            </Card>
          ) : (
            <ul className="max-h-[calc(100vh-15rem)] space-y-2 overflow-y-auto pr-1">
              {listed.map((l) => {
                const km = me ? distanceKm(me, { lat: l.latitude, lng: l.longitude }) : null;
                const dir = directionsHref(l);
                return (
                  <li key={l.id} className={`rounded-card border bg-surface p-3 shadow-card ${focus === l.id ? "border-brand-500" : "border-line-soft"}`}>
                    <div className="flex items-start gap-3">
                      <input type="checkbox" className="mt-1 h-4.5 w-4.5 flex-none accent-brand-600" checked={picked.includes(l.id)} onChange={() => togglePick(l.id)} aria-label={`Add ${l.name} to the route`} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setFocus(l.id)}>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-sm font-semibold text-ink">{l.name}</span>
                          <LeadStatusBadge status={l.status} />
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-ink-muted">{addressLine(l) || l.phone}</span>
                        {km !== null && <span className="text-xs font-medium text-ink-soft">{km < 1 ? `${Math.round(km * 1000)} m away` : `${km.toFixed(1)} km away`}</span>}
                      </button>
                      {dir && (
                        <a href={dir} target="_blank" rel="noreferrer" aria-label={`Directions to ${l.name}`} title="Directions" className="grid h-8 w-8 flex-none place-items-center rounded-full text-brand-700 ring-1 ring-inset ring-brand-200 hover:bg-brand-50">
                          <Icon name="route" size={15} />
                        </a>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DevoteeMapPage() {
  return (
    <Suspense fallback={<Skeleton className="h-[60vh] w-full" rounded="rounded-panel" />}>
      <MapScreen />
    </Suspense>
  );
}
