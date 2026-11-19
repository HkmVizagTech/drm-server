"use client";

// Where the lead lives, as a pin: from the phone's GPS (standing at their door), from the address
// typed in (Google's geocoder), or by tapping or dragging the pin on the map. A pin placed on the
// map (rather than found from the typed address) is looked up the other way too, and the address
// Google has for that spot is handed to the form to fill in. Without a Maps key the GPS button
// still works, and directions fall back to the address text.

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import { addressFrom, addressOfPlace, currentPosition, homeMarker, isRoughMatch, loadGoogleMaps, mapIdOr, toLiteral, VIZAG, type GAdvancedMarker, type GMap, type LatLngLiteral, type MapAddress, type MapsApi } from "@/lib/google-maps";
import { distanceKm, type DevoteeConfig } from "@/lib/devotee";

export function LocationPicker({
  value,
  onChange,
  address,
  config,
  onAddress,
}: {
  value: LatLngLiteral | null;
  onChange: (v: LatLngLiteral | null) => void;
  /** The address Google has for a pin placed by GPS, tap or drag. */
  onAddress?: (a: MapAddress) => void;
  /** The address as typed, for "Find address on map". */
  address: string;
  config: DevoteeConfig | null;
}) {
  const [busy, setBusy] = useState<"gps" | "find" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Where Google put the typed address, when that is far from a pin already placed by hand.
  const [elsewhere, setElsewhere] = useState<LatLngLiteral | null>(null);
  const [maps, setMaps] = useState<MapsApi | null>(null);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<GMap | null>(null);
  const marker = useRef<GAdvancedMarker | null>(null);
  // A pin placed by hand: keep it, then ask Google what address is there. The map's own
  // listeners are set up once, so they reach this through a ref that always holds the latest.
  async function placed(p: LatLngLiteral, placeId?: string, api: MapsApi | null = maps) {
    onChange(p);
    setElsewhere(null);
    if (!api || !onAddress) return;
    try {
      // A named place that was tapped is described by its own record; a bare point by the
      // addresses Google knows near it.
      const a = placeId
        ? await addressOfPlace(api, placeId)
        : addressFrom((await new api.Geocoder().geocode({ location: p })).results);
      if (a) {
        onAddress(a);
        setMessage(`Address from the map: ${a.formatted}`);
      }
    } catch {
      setMessage("Pinned. Google has no address for this spot - type it in above.");
    }
  }
  const place = useRef(placed);
  useEffect(() => {
    place.current = placed;
  });

  const key = config?.maps_key ?? null;

  useEffect(() => {
    if (!key) return;
    let live = true;
    loadGoogleMaps(key)
      .then((m) => live && setMaps(m))
      .catch((e: Error) => live && setMessage(e.message));
    return () => {
      live = false;
    };
  }, [key]);

  // The map, once: a tap on it moves the pin there.
  useEffect(() => {
    if (!maps || !el.current || map.current) return;
    map.current = new maps.Map(el.current, {
      center: value ?? VIZAG,
      zoom: value ? 16 : 12,
      mapId: mapIdOr(config?.map_id),
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "cooperative",
    });
    map.current.addListener("click", (e) => {
      const p = toLiteral(e.latLng);
      if (!p) return;
      // A tap on a named place: keep Google's own bubble closed - the form shows what it found.
      if (e.placeId) e.stop?.();
      void place.current(p, e.placeId);
    });
  }, [maps, value, config?.map_id]);

  // The pin follows the value; dragging it sets the value.
  useEffect(() => {
    if (!maps || !map.current) return;
    if (!value) {
      if (marker.current) marker.current.map = null;
      marker.current = null;
      return;
    }
    if (!marker.current) {
      marker.current = new maps.marker.AdvancedMarkerElement({ map: map.current, position: value, gmpDraggable: true, title: "Drag to the exact place", content: homeMarker() });
      marker.current.addListener("dragend", () => {
        const p = toLiteral(marker.current?.position);
        if (p) void place.current(p);
      });
    } else {
      marker.current.position = value;
    }
    map.current.panTo(value);
    if ((map.current.getZoom() ?? 0) < 15) map.current.setZoom(16);
  }, [maps, value]);

  async function locateMe() {
    setBusy("gps");
    setMessage(null);
    try {
      await placed(await currentPosition());
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // The typed address, looked up. A pin the devotee placed themselves is the better truth (an
  // Indian address typed as colony + city geocodes to the colony's middle), so an existing pin is
  // never moved quietly: if Google's spot is more than a short walk away, they choose.
  async function findAddress() {
    if (!maps || !address.trim()) return;
    setBusy("find");
    setMessage(null);
    setElsewhere(null);
    try {
      const r = await new maps.Geocoder().geocode({ address, region: "in", componentRestrictions: { country: "IN" } });
      const hit = r.results[0];
      if (!hit) setMessage("Google could not find that address. Tap the map or drag the pin instead.");
      else {
        const spot = toLiteral(hit.geometry.location)!;
        const rough = isRoughMatch(hit);
        const away = value ? distanceKm(value, spot) : 0;
        if (value && away > 0.15) {
          setElsewhere(spot);
          setMessage(
            `Google places "${hit.formatted_address}" ${away < 1 ? `${Math.round(away * 1000)} m` : `${away.toFixed(1)} km`} from your pin` +
              (rough ? " - and only roughly, not the exact house." : ".") +
              " Your pin is kept."
          );
        } else {
          onChange(spot);
          setMessage(
            rough
              ? `Google found only the area (${hit.formatted_address}), not the exact house. Drag the pin to the right place.`
              : `Found: ${hit.formatted_address}. Drag the pin if it is not exact.`
          );
        }
      }
    } catch {
      setMessage("Google could not find that address. Drag the pin instead.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" icon="locate" loading={busy === "gps"} onClick={() => void locateMe()}>
          Use my current location
        </Button>
        {key && (
          <Button variant="secondary" size="sm" icon="search" loading={busy === "find"} disabled={!maps || !address.trim()} onClick={() => void findAddress()}>
            Find address on map
          </Button>
        )}
        {value && (
          <Button variant="ghost" size="sm" icon="x" onClick={() => onChange(null)}>
            Remove pin
          </Button>
        )}
      </div>
      {key ? (
        <div ref={el} className="h-56 w-full overflow-hidden rounded-card border border-line-soft bg-sunken" aria-label="Map: tap or drag the pin to set the location" />
      ) : (
        <p className="text-xs text-ink-muted">
          The map preview appears once the temple office adds a Google Maps key. Your location is still saved and used for directions.
        </p>
      )}
      {value && (
        <p className="flex items-center gap-1 text-xs text-ink-muted">
          <Icon name="mapPin" size={13} />
          Pinned at {value.lat.toFixed(5)}, {value.lng.toFixed(5)} ·{" "}
          <a className="text-brand-700 hover:underline" href={`https://www.google.com/maps/search/?api=1&query=${value.lat},${value.lng}`} target="_blank" rel="noreferrer">
            Check in Google Maps
          </a>
        </p>
      )}
      {message && (
        <p className="text-xs text-ink-soft">
          {message}
          {elsewhere && (
            <>
              {" "}
              <button type="button" className="font-semibold text-brand-700 hover:underline" onClick={() => void placed(elsewhere)}>
                Move pin there
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
