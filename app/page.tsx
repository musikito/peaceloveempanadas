import { supabaseService, publicImageUrl } from "@/lib/supabase/admin";
import { getSettings, toPublicSettings } from "@/lib/settings";
import { getSlotDays } from "@/lib/slots";
import type { Product } from "@/lib/types";
import Shop, { type MenuItem } from "./shop";

export const dynamic = "force-dynamic"; // prices, stock and time slots must always be fresh

export default async function Home({ searchParams }: { searchParams: Promise<{ canceled?: string }> }) {
  const { canceled } = await searchParams;
  const settings = await getSettings();
  const { data } = await supabaseService()
    .from("products")
    .select("id,name,description,price_cents,image_path,sort")
    .eq("active", true)
    .order("sort")
    .order("name");

  const menu: MenuItem[] = ((data ?? []) as Product[]).map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    price_cents: p.price_cents,
    image: publicImageUrl(p.image_path),
  }));
  const slotDays = settings.accepting_orders ? await getSlotDays(settings) : [];

  return (
    <>
      <header className="band">
        <div className="band-inner">
          <h1 className="shop-name">{settings.shop_name}</h1>
          <p>Baked to order. Choose delivery or pickup and the time you want them.</p>
        </div>
      </header>

      {canceled && (
        <div className="notice" role="status">Checkout was canceled. Your order is still here if you want to try again.</div>
      )}
      {!settings.accepting_orders && (
        <div className="notice error" role="status">We&apos;re not taking orders right now. Check back soon.</div>
      )}

      <Shop menu={menu} settings={toPublicSettings(settings)} slotDays={slotDays} />
    </>
  );
}
