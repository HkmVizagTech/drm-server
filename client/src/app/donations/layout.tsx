import DashboardLayout from "@/components/dashboard-layout";

export default function DonationsLayout({ children }: LayoutProps<"/donations">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
