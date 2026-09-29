import DashboardLayout from "@/components/dashboard-layout";

export default function ReportsLayout({ children }: LayoutProps<"/reports">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
