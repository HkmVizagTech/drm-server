import DashboardLayout from "@/components/dashboard-layout";

export default function Layout({ children }: LayoutProps<"/whatsapp">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
