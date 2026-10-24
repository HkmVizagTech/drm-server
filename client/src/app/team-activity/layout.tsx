import DashboardLayout from "@/components/dashboard-layout";

export default function TeamActivityLayout({ children }: LayoutProps<"/team-activity">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
