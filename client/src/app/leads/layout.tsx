import DashboardLayout from "@/components/dashboard-layout";

export default function Layout({ children }: LayoutProps<"/leads">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
