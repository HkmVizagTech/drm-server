import DashboardLayout from "@/components/dashboard-layout";

export default function PagesLayout({ children }: LayoutProps<"/pages">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
