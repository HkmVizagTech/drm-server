import DashboardLayout from "@/components/dashboard-layout";

export default function DashboardPageLayout({ children }: LayoutProps<"/dashboard">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
