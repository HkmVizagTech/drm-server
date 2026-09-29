import DashboardLayout from "@/components/dashboard-layout";

export default function Layout({ children }: LayoutProps<"/calling">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
