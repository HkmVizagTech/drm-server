import DashboardLayout from "@/components/dashboard-layout";

export default function SevaLayout({ children }: LayoutProps<"/seva">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
