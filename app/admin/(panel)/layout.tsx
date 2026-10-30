import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import Nav from "./nav";

export const metadata: Metadata = { title: "Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const settings = await getSettings();
  return (
    <div className="admin">
      <Nav shopName={settings.shop_name} />
      <main className="admin-main">{children}</main>
    </div>
  );
}
