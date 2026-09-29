import DashboardLayout from "@/components/dashboard-layout";

export default function PeopleLayout({ children }: LayoutProps<"/people">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
