// Google Maps for the devotee screens, loaded only when a page needs it and only once.
//
// The key comes from the server (GOOGLE_MAPS_API_KEY, via /api/devotee/config) rather than being
// baked into the build, the same reason the API has no NEXT_PUBLIC_API_URL: one build, any host.
// Restrict the key to this site's address in the Google Cloud console - it is visible in the page,
// as every Maps JavaScript key is. It needs "Maps JavaScript API", and "Geocoding API" for
// "Find address on map".
//
import { inApp } from "./phone-app";

// The types below are the small part of the Maps API these screens use, so there is no
// @types/google.maps to keep in step.

export interface LatLngLiteral {
  lat: number;
  lng: number;
}
interface LatLngObject {
  lat(): number;
  lng(): number;
}
export type LatLngLike = LatLngLiteral | LatLngObject;

export interface GMap {
  setCenter(p: LatLngLiteral): void;
  setZoom(z: number): void;
  getZoom(): number | undefined;
  panTo(p: LatLngLiteral): void;
  fitBounds(b: GBounds, padding?: number): void;
  addListener(event: string, fn: (e: { latLng?: LatLngObject | null; placeId?: string; stop?: () => void }) => void): { remove(): void };
}
export interface GBounds {
  extend(p: LatLngLiteral): void;
}
export interface GAdvancedMarker {
  map: GMap | null;
  position: LatLngLike | null;
  addListener(event: string, fn: () => void): { remove(): void };
}
export interface GInfoWindow {
  setContent(c: Node | string): void;
  open(o: { map: GMap; anchor?: GAdvancedMarker }): void;
  close(): void;
}
interface GeocodeResult {
  formatted_address: string;
  geometry: { location: LatLngObject; location_type?: string };
  partial_match?: boolean;
  types?: string[];
  address_components: { long_name: string; short_name: string; types: string[] }[];
}

/** A named place (a shop, a nursery, an apartment block) as the Places API describes it. */
interface PlaceDetails {
  displayName?: string | null;
  formattedAddress?: string | null;
  addressComponents?: { longText: string; shortText: string; types: string[] }[] | null;
}

export interface MapsApi {
  importLibrary?: (name: string) => Promise<unknown>;
  Map: new (el: HTMLElement, opts: Record<string, unknown>) => GMap;
  LatLngBounds: new () => GBounds;
  InfoWindow: new (opts?: Record<string, unknown>) => GInfoWindow;
  Geocoder: new () => { geocode(req: Record<string, unknown>): Promise<{ results: GeocodeResult[] }> };
  marker: {
    AdvancedMarkerElement: new (opts: Record<string, unknown>) => GAdvancedMarker;
    PinElement: new (opts: Record<string, unknown>) => { element: HTMLElement };
  };
}

let loading: Promise<MapsApi> | null = null;

export function loadGoogleMaps(key: string): Promise<MapsApi> {
  if (loading) return loading;
  loading = new Promise<MapsApi>((resolve, reject) => {
    const w = window as unknown as { google?: { maps?: MapsApi }; __drmMapsReady?: () => void };
    if (w.google?.maps?.marker) return resolve(w.google.maps);
    w.__drmMapsReady = () => {
      if (w.google?.maps) resolve(w.google.maps);
      else reject(new Error("Google Maps did not load."));
    };
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker&callback=__drmMapsReady`;
    s.async = true;
    s.onerror = () => {
      loading = null;
      reject(new Error("Google Maps could not be reached. Check the connection."));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** A marker's position as plain numbers, whichever form the API handed back. */
export function toLiteral(p: LatLngLike | null | undefined): LatLngLiteral | null {
  if (!p) return null;
  return typeof (p as LatLngObject).lat === "function"
    ? { lat: (p as LatLngObject).lat(), lng: (p as LatLngObject).lng() }
    : (p as LatLngLiteral);
}

/** An address as the lead form holds it, read back from a point on the map. */
export interface MapAddress {
  address_line: string;
  area: string;
  city: string;
  pincode: string;
  /** Google's own one-line form, to show the devotee what was found. */
  formatted: string;
}

type Component = GeocodeResult["address_components"][number];

/**
 * Split Google's answer for a point into the form's fields.
 *
 * Indian addresses rarely come back with a house number; what Google does know is the road,
 * the colony (sublocality) and the city. The first result is the most exact, so the street part
 * comes only from it; area, city and PIN may come from the next few when the first lacks them.
 */
export function addressFrom(results: GeocodeResult[], placeName?: string | null): MapAddress | null {
  const top = results[0];
  if (!top) return null;
  const pool = results.slice(0, 5).flatMap((r) => r.address_components);
  const find = (list: Component[], ...types: string[]) => {
    for (const t of types) {
      const c = list.find((x) => x.types.includes(t));
      if (c) return c.long_name;
    }
    return "";
  };
  const area = find(pool, "sublocality_level_1", "sublocality", "neighborhood", "sublocality_level_2");
  const street = [
    find(top.address_components, "subpremise"),
    find(top.address_components, "premise"),
    find(top.address_components, "street_number"),
    find(top.address_components, "route"),
    find(top.address_components, "sublocality_level_3"),
    find(top.address_components, "sublocality_level_2"),
  ].filter((p, i, all) => p && p !== area && !/^unnamed road$/i.test(p) && all.indexOf(p) === i);
  // A tapped named place leads the line: "Vanamali Nursery" is how the devotee will find it.
  if (placeName && !street.includes(placeName)) street.unshift(placeName);
  // No road from a nearby result is borrowed: a pin beside a highway is not ON the highway, and
  // an empty field the devotee fills in beats a confident wrong one.
  const pin = find(pool, "postal_code");
  return {
    address_line: street.join(", "),
    area,
    city: find(pool, "locality", "administrative_area_level_3", "administrative_area_level_2"),
    pincode: /^\d{6}$/.test(pin) ? pin : "",
    formatted: top.formatted_address,
  };
}

/**
 * A place tapped on the map, by its Google place id: its name and its own address, which is
 * exact where a lookup by coordinates only knows the nearest road. Uses the Places API (New)
 * when the key allows it, and falls back to the geocoder (address without the name) when not.
 */
export async function addressOfPlace(api: MapsApi, placeId: string): Promise<MapAddress | null> {
  try {
    const lib = (await api.importLibrary?.("places")) as
      | { Place: new (o: { id: string }) => PlaceDetails & { fetchFields(o: { fields: string[] }): Promise<unknown> } }
      | undefined;
    if (lib?.Place) {
      const place = new lib.Place({ id: placeId });
      await place.fetchFields({ fields: ["displayName", "formattedAddress", "addressComponents"] });
      if (place.addressComponents?.length) {
        const result: GeocodeResult = {
          formatted_address: place.formattedAddress ?? "",
          geometry: { location: { lat: () => 0, lng: () => 0 } },
          address_components: place.addressComponents.map((c) => ({ long_name: c.longText, short_name: c.shortText, types: c.types })),
        };
        const a = addressFrom([result], place.displayName);
        if (a) return { ...a, formatted: [place.displayName, place.formattedAddress].filter(Boolean).join(", ") };
      }
    }
  } catch {
    // Places API not enabled for this key: the geocoder still knows the place's address.
  }
  try {
    return addressFrom((await new api.Geocoder().geocode({ placeId })).results);
  } catch {
    return null;
  }
}

/**
 * Did Google find the house, or only the area? An address geocoded to a whole locality or PIN
 * lands in its middle, which is no place to put a lead's pin.
 */
export function isRoughMatch(r: GeocodeResult): boolean {
  const t = r.geometry.location_type;
  return !!r.partial_match || t === "APPROXIMATE" || t === "GEOMETRIC_CENTER";
}

/* ------------------------------------------------------------------ markers */
//
// DRM's own markers, drawn as a round badge with a pointer rather than Google's teardrop pin -
// so a lead never looks like one of Google's shops or landmarks on the same map. Built from DOM
// nodes, never an HTML string, so a lead's name cannot become markup.

function badge(fill: string, ring: string, inner: Node, size = 34): HTMLElement {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;cursor:pointer;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))";
  const disc = document.createElement("div");
  disc.style.cssText =
    `width:${size}px;height:${size}px;border-radius:50%;background:${fill};border:3px solid #fff;` +
    `box-shadow:0 0 0 2px ${ring};display:grid;place-items:center;color:#fff;` +
    "font:700 12px/1 system-ui,sans-serif;letter-spacing:.02em";
  disc.append(inner);
  // The pointer: a small triangle whose tip is the exact spot.
  const tip = document.createElement("div");
  tip.style.cssText = `width:0;height:0;margin-top:-2px;border-left:6px solid transparent;border-right:6px solid transparent;border-top:8px solid #fff`;
  wrap.append(disc, tip);
  return wrap;
}

/** A lead on the map: their initials on the status colour. A gold ring marks a high chance of donating. */
export function leadMarker(name: string, colour: string, high = false): HTMLElement {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2)).toUpperCase();
  const text = document.createElement("span");
  text.textContent = letters;
  return badge(colour, high ? "#f59e0b" : "rgba(0,0,0,.18)", text);
}

/** The pin being placed on the Add / Edit lead form: a house, in DRM's green. */
export function homeMarker(): HTMLElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "#fff");
  svg.setAttribute("stroke-width", "2.2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 11 12 4l8 7v8a2 2 0 0 1-2 2h-3v-6H9v6H6a2 2 0 0 1-2-2v-8Z");
  svg.append(path);
  return badge("#2b6e2f", "rgba(43,110,47,.35)", svg, 38);
}

/** Visakhapatnam, for a map with nothing on it yet. */
export const VIZAG: LatLngLiteral = { lat: 17.6868, lng: 83.2185 };

/** The Map ID for advanced markers. Google's demo ID works until the temple makes its own. */
export const mapIdOr = (id: string | null | undefined) => id || "DEMO_MAP_ID";

/** The device's location, or a sentence saying why not. */
export function currentPosition(): Promise<LatLngLiteral> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return reject(new Error("This device cannot share its location."));
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      (e) =>
        reject(
          new Error(
            e.code === e.PERMISSION_DENIED
              ? inApp()
                ? "Location is not allowed for DRM. Open Settings > Apps > DRM > Permissions > Location, choose Allow, and try again."
                : "Location is blocked for this site. Allow it in the browser settings and try again."
              : e.code === e.POSITION_UNAVAILABLE
                ? "Your phone's location (GPS) is off. Turn on Location in quick settings and try again."
                : "Could not find your location in time. Try again outside or with GPS on."
          )
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 }
    );
  });
}
