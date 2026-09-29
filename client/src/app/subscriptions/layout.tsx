import DashboardLayout from "@/components/dashboard-layout";

export default function SubscriptionsLayout({ children }: LayoutProps<"/subscriptions">) {
  return <DashboardLayout>{children}</DashboardLayout>;
}
