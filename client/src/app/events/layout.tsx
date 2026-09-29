import DashboardLayout from "@/components/dashboard-layout";

export default function EventsLayout({ children }: LayoutProps<"/events">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
