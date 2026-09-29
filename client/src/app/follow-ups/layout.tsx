import DashboardLayout from "@/components/dashboard-layout";

export default function Layout({ children }: LayoutProps<"/follow-ups">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
