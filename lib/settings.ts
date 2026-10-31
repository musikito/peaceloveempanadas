import "server-only";
import { supabaseService } from "@/lib/supabase/admin";
import type { PublicSettings, Settings } from "@/lib/types";

export async function getSettings(): Promise<Settings> {
  const { data, error } = await supabaseService().from("settings").select("*").eq("id", 1).single();
  if (error || !data) throw new Error("Settings row missing. Did you run supabase/schema.sql?");
  return data as Settings;
}

export function toPublicSettings(s: Settings): PublicSettings {
  return {
    shop_name: s.shop_name,
    timezone: s.timezone,
    accepting_orders: s.accepting_orders,
    delivery_enabled: s.delivery_enabled,
    pickup_enabled: s.pickup_enabled,
    delivery_fee_cents: s.delivery_fee_cents,
    min_order_cents: s.min_order_cents,
    delivery_zips: s.delivery_zips,
    pickup_address: s.pickup_address,
    logo_path: s.logo_path ?? null,
  };
}
