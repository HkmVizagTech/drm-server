"use client";

// Every signed-in devotee screen. The sign-in page itself (/devotee) sits outside this group.

import type { ReactNode } from "react";
import { DevoteeShell } from "@/components/devotee/shell";

export default function DevoteePortalLayout({ children }: { children: ReactNode }) {
  return <DevoteeShell>{children}</DevoteeShell>;
}
