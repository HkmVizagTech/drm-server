"use client";

// The devotee's leads as pins, coloured by where each one stands. Tapping a pin shows who it is,
// with Call, Directions and Open. Built from DOM nodes rather than an HTML string, so a name typed
// into a lead can never become markup in the page.

import { useEffect, useRef, useState } from "react";
import { leadMarker, loadGoogleMaps, mapIdOr, VIZAG, type GAdvancedMarker, type GInfoWindow, type GMap, type LatLngLiteral, type MapsApi } from "@/lib/google-maps";
import { STATUS, addressLine, directionsHref, telHref, type DevoteeConfig, type LeadStatus } from "@/lib/devotee";

export interface MapLead {
  id: string;
  name: string;
  phone: string;
  status: LeadStatus;
  priority: string;
  address_line: string | null;
  area: string | null;
  city: string | null;
  pincode: string | null;
  latitude: number;
  longitude: number;
  next_follow_up_at: string | null;
  total_donated: number;
}

/** Pin colours by status. Map pins sit on Google's own palette, so these are plain colours. */
export const PIN: Record<LeadStatus, string> = {
  new: "#0284c7",
  interested: "#2b6e2f",
  call_later: "#d97706",
  not_answered: "#6b7280",
  invalid_number: "#dc2626",
  not_interested: "#9ca3af",
  donated: "#059669",
};

function popup(l: MapLead, onOpen: (id: string) => void): HTMLElement {
  const box = document.createElement("div");
  box.style.cssText = "font: 13px system-ui, sans-serif; min-width: 180px; max-width: 240px; color: #111";
  const title = document.createElement("div");
  title.style.cssText = "font-weight: 600; font-size: 14px";
  title.textContent = l.name;
  const meta = document.createElement("div");
  meta.style.cssText = "color: #555; margin-top: 2px";
  meta.textContent = `${STATUS[l.status].label} · ${l.phone}`;
  const where = document.createElement("div");
  where.style.cssText = "color: #666; margin-top: 4px";
  where.textContent = addressLine(l);
  const row = document.createElement("div");
  row.style.cssText = "display: flex; gap: 10px; margin-top: 8px; font-weight: 600";
  const link = (text: string, href: string, external: boolean) => {
    const a = document.createElement("a");
    a.textContent = text;
    a.href = href;
    a.style.color = "#2b6e2f";
    if (external) {
      a.target = "_blank";
      a.rel = "noreferrer";
    }
    return a;
  };
  row.append(link("Call", telHref(l.phone), false));
  const dir = directionsHref(l);
  if (dir) row.append(link("Directions", dir, true));
  const open = link("Open", `/devotee/leads/${l.id}`, false);
  open.addEventListener("click", (e) => {
    e.preventDefault();
    onOpen(l.id);
  });
  row.append(open);
  box.append(title, meta);
  if (where.textContent) box.append(where);
  box.append(row);
  return box;
}

export function LeadsMap({
  leads,
  config,
  me,
  focusId,
  onOpen,
  className = "",
}: {
  leads: MapLead[];
  config: DevoteeConfig;
  me: LatLngLiteral | null;
  focusId?: string | null;
  onOpen: (id: string) => void;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [maps, setMaps] = useState<MapsApi | null>(null);
  const [error, setError] = useState<string | null>(null);
  const map = useRef<GMap | null>(null);
  const info = useRef<GInfoWindow | null>(null);
  const pins = useRef(new Map<string, GAdvancedMarker>());
  const meMarker = useRef<GAdvancedMarker | null>(null);
  const fitted = useRef(false);
  const open = useRef(onOpen);
  useEffect(() => {
    open.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    if (!config.maps_key) return;
    let live = true;
    loadGoogleMaps(config.maps_key)
      .then((m) => live && setMaps(m))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [config.maps_key]);

  useEffect(() => {
    if (!maps || !el.current || map.current) return;
    map.current = new maps.Map(el.current, {
      center: VIZAG,
      zoom: 12,
      mapId: mapIdOr(config.map_id),
      streetViewControl: false,
      mapTypeControl: false,
      fullscreenControl: true,
      clickableIcons: false,
    });
    info.current = new maps.InfoWindow();
  }, [maps, config.map_id]);

  // Pins: add the new, move the changed, drop the gone.
  useEffect(() => {
    const m = map.current;
    if (!maps || !m) return;
    const keep = new Set(leads.map((l) => l.id));
    for (const [id, mk] of pins.current) {
      if (!keep.has(id)) {
        mk.map = null;
        pins.current.delete(id);
      }
    }
    for (const l of leads) {
      const pos = { lat: l.latitude, lng: l.longitude };
      const existing = pins.current.get(l.id);
      if (existing) {
        existing.position = pos;
        continue;
      }
      const mk = new maps.marker.AdvancedMarkerElement({ map: m, position: pos, title: l.name, content: leadMarker(l.name, PIN[l.status], l.priority === "hot") });
      mk.addListener("click", () => {
        info.current?.setContent(popup(l, (id) => open.current(id)));
        info.current?.open({ map: m, anchor: mk });
      });
      pins.current.set(l.id, mk);
    }
    // Frame everything once, the first time there is something to frame.
    if (!fitted.current && leads.length) {
      const b = new maps.LatLngBounds();
      leads.forEach((l) => b.extend({ lat: l.latitude, lng: l.longitude }));
      if (me) b.extend(me);
      if (leads.length === 1 && !me) {
        m.setCenter({ lat: leads[0].latitude, lng: leads[0].longitude });
        m.setZoom(15);
      } else m.fitBounds(b, 48);
      fitted.current = true;
    }
  }, [maps, leads, me]);

  // "You are here".
  useEffect(() => {
    const m = map.current;
    if (!maps || !m || !me) return;
    if (!meMarker.current) {
      const dot = document.createElement("div");
      dot.style.cssText = "width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.35)";
      meMarker.current = new maps.marker.AdvancedMarkerElement({ map: m, position: me, title: "You are here", content: dot, zIndex: 999 });
    } else meMarker.current.position = me;
  }, [maps, me]);

  // A lead asked for by the page (from ?focus=, or a tap in the list): centre it and say who it is.
  useEffect(() => {
    const m = map.current;
    if (!maps || !m || !focusId) return;
    const l = leads.find((x) => x.id === focusId);
    const mk = pins.current.get(focusId);
    if (!l || !mk) return;
    m.panTo({ lat: l.latitude, lng: l.longitude });
    if ((m.getZoom() ?? 0) < 15) m.setZoom(16);
    info.current?.setContent(popup(l, (id) => open.current(id)));
    info.current?.open({ map: m, anchor: mk });
  }, [maps, focusId, leads]);

  if (error) {
    return <div className={`grid place-items-center rounded-card border border-line-soft bg-sunken p-6 text-center text-sm text-ink-muted ${className}`}>{error}</div>;
  }
  return <div ref={el} className={`overflow-hidden rounded-card border border-line-soft bg-sunken ${className}`} role="region" aria-label="Map of your leads" />;
}
