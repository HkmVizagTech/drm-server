// One icon set, drawn once.
//
// WHY A FILE RATHER THAN A PACKAGE
// DRM has no icon dependency and does not need one: the whole product uses
// about thirty glyphs. A package would add weight and a second visual language
// to reconcile with the ones already hand-drawn into the sidebar.
//
// WHY A FILE RATHER THAN MORE INLINE SVG
// Because that is what was there, and it had drifted: stroke widths of 1.6,
// 1.8 and 2 across the app, path data stored as bare strings on nav items,
// arrows rendered as the literal characters "→" and "←" in four places. At a
// small size stroke width is most of what makes a set look like a set, so it
// is fixed here and cannot vary by call site.
//
// Every icon is drawn on a 24-unit grid with round caps and joins, inherits
// currentColor, and is aria-hidden - an icon in this product always sits
// beside a label or inside a button with an aria-label, never alone carrying
// meaning.

import type { SVGProps } from "react";

export type IconName =
  | "search" | "plus" | "download" | "upload" | "refresh" | "filter" | "settings"
  | "chevronDown" | "chevronUp" | "chevronLeft" | "chevronRight"
  | "arrowRight" | "arrowLeft" | "arrowUp" | "arrowDown" | "externalLink"
  | "check" | "checkCircle" | "x" | "xCircle" | "alert" | "info" | "help"
  | "phone" | "phoneOutgoing" | "message" | "mail" | "bell" | "calendar" | "clock"
  | "user" | "users" | "userPlus" | "logout" | "menu" | "more"
  | "edit" | "trash" | "copy" | "file" | "fileText" | "sheet" | "receipt"
  | "qr" | "rupee" | "chart" | "home" | "list" | "inbox" | "link" | "tag"
  | "star" | "sparkle" | "shield" | "box" | "target" | "trendUp" | "eye";

// Paths only - the wrapper supplies viewBox, stroke and sizing, so a new icon
// cannot arrive with a different weight than the rest.
const PATHS: Record<IconName, string> = {
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  download: "M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2",
  upload: "M12 21V9m0 0 4 4m-4-4-4 4M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2",
  refresh: "M20 11a8 8 0 0 0-13.7-5.7L3 8M3 4v4h4m-3 5a8 8 0 0 0 13.7 5.7L21 16m0 4v-4h-4",
  filter: "M3 5h18l-7 8v6l-4 2v-8L3 5Z",
  // A sliders glyph rather than a cog. A cog at 16px turns to mush - the teeth
  // are sub-pixel at this stroke weight - and "settings" in this product means
  // adjusting values anyway, not machinery.
  settings: "M5 6h14M5 12h14M5 18h14M9 4v4m6 2v4M11 16v4",
  chevronDown: "m6 9 6 6 6-6",
  chevronUp: "m6 15 6-6 6 6",
  chevronLeft: "m15 6-6 6 6 6",
  chevronRight: "m9 6 6 6-6 6",
  arrowRight: "M5 12h14m0 0-6-6m6 6-6 6",
  arrowLeft: "M19 12H5m0 0 6 6m-6-6 6-6",
  arrowUp: "M12 19V5m0 0-6 6m6-6 6 6",
  arrowDown: "M12 5v14m0 0 6-6m-6 6-6-6",
  externalLink: "M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4",
  check: "m4.5 12.5 5 5 10-11",
  checkCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3.5-9.2 2.5 2.5 5-5.3",
  x: "M6 6l12 12M18 6 6 18",
  xCircle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm3-12-6 6m0-6 6 6",
  alert: "M12 9v4m0 4h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-9v4.5M12 8h.01",
  help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.2-11a2.2 2.2 0 1 1 3 2.1c-.5.2-.8.7-.8 1.2v.4m0 3h.01",
  phone: "M7 3h3l1.5 4-2 1.5a12 12 0 0 0 6 6L17 12.5l4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3 5.2 2 2 0 0 1 5 3h2Z",
  phoneOutgoing: "M7 3h3l1.5 4-2 1.5a12 12 0 0 0 6 6L17 12.5l4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 3 5.2 2 2 0 0 1 5 3h2ZM16 8l5-5m0 0h-4m4 0v4",
  message: "M21 11.5a8 8 0 0 1-11.6 7.1L3 21l2.4-6A8 8 0 1 1 21 11.5Z",
  mail: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Zm0 .5 9 6 9-6",
  bell: "M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6M13.7 20a2 2 0 0 1-3.4 0",
  calendar: "M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Zm0 2.5h18M8 3v4m8-4v4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0",
  users: "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-7 9a7 7 0 0 1 14 0m.5-15.7a3.5 3.5 0 0 1 0 6.9M19 20a7 7 0 0 0-2.5-5.4",
  userPlus: "M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-7 9a7 7 0 0 1 14 0M19 8v6m3-3h-6",
  logout: "M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3m7 13 4-4m0 0-4-4m4 4H10",
  menu: "M4 7h16M4 12h16M4 17h16",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  edit: "M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3ZM15 6l3 3",
  trash: "M4 7h16M10 11v6m4-6v6M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2",
  copy: "M9 9a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V9Zm-4 6H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v0",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5",
  fileText: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Zm0 0v5h5M9 13h6m-6 4h4",
  sheet: "M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm0 4.5h16M4 15h16M10 4.5v15",
  receipt: "M5 3h14v18l-2.3-1.6L14.4 21l-2.4-1.6L9.6 21l-2.3-1.6L5 21V3Zm3.5 5h7m-7 4h7m-7 4h4",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2.5v2.5H14V14Zm3.5 3.5H20V20h-2.5v-2.5Z",
  rupee: "M7 4h10M7 8.5h10M16 4c0 3.6-2.5 4.5-5.5 4.5H7l8 11.5",
  chart: "M4 20V9m5 11V4m5 16v-7m5 7V7",
  home: "M4 11 12 4l8 7v8a2 2 0 0 1-2 2h-3v-6H9v6H6a2 2 0 0 1-2-2v-8Z",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  inbox: "M4 13h4l1.5 3h5L16 13h4M4 13 6.4 5.6A2 2 0 0 1 8.3 4h7.4a2 2 0 0 1 1.9 1.6L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z",
  link: "M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6.3m1.5 7.2a4 4 0 0 1-5.7 0 4 4 0 0 1 0-5.7l1.5-1.5",
  tag: "M11 3H5a2 2 0 0 0-2 2v6l9.5 9.5a2 2 0 0 0 2.8 0l5.2-5.2a2 2 0 0 0 0-2.8L11 3Zm-3.5 5h.01",
  star: "m12 3.5 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 10l6.1-.9L12 3.5Z",
  sparkle: "M12 3.5 13.7 9l5.5 1.7-5.5 1.8L12 18l-1.7-5.5L4.8 10.7 10.3 9 12 3.5ZM19 16.5l.7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z",
  shield: "M12 3 5 6v6c0 4.4 3 8.2 7 9 4-.8 7-4.6 7-9V6l-7-3Zm-2.5 9 2 2 4-4.3",
  box: "m12 3 8 4.2v9.6L12 21l-8-4.2V7.2L12 3Zm0 0v18m8-13.8L12 12 4 7.2",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-4.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Zm0-3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
  trendUp: "M3 17 9.5 10.5l4 4L21 7m0 0h-5m5 0v5",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 2.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Pixel size for both dimensions. 16 inside buttons, 18-20 standalone. */
  size?: number;
}

export function Icon({ name, size = 16, className = "", ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      className={`flex-none ${className}`}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The busy indicator.
 *
 * Separate from Icon because it is a circle with a gap rather than a path, and
 * because it is the one "icon" that must never be aria-hidden when it stands
 * alone - a screen reader user waiting on a save needs to be told something is
 * happening.
 */
export function Spinner({
  size = 16,
  className = "",
  label,
}: {
  size?: number;
  className?: string;
  /** Announced when the spinner is the only thing on screen saying "wait". */
  label?: string;
}) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-flex flex-none ${className}`}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" className="spin">
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.22" strokeWidth="2.5" />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
