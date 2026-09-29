import { ReactNode } from "react";
import { Sidebar } from "./sidebar";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen bg-[var(--page)] text-slate-900">
      <Sidebar />
      {/* min-w-0 matters: without it a wide table inside a flex child refuses to
          shrink and pushes the whole layout sideways instead of scrolling. */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-[1400px] mx-auto px-6 py-7">{children}</div>
      </main>
    </div>
  );
}
