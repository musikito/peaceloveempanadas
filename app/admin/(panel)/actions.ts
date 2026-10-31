"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { supabaseUser } from "@/lib/supabase/server";
import { parseMoneyToCents } from "@/lib/money";
import { sendSms } from "@/lib/twilio";
import type { OrderStatus } from "@/lib/types";

// Every action re-checks admin rights: server actions are public POST endpoints.
// Writes go through the user's own Supabase session, so RLS enforces it a second time.

export async function signOut() {
  const supabase = await supabaseUser();
  await supabase.auth.signOut();
  redirect("/admin/login");
}

function back(path: string, msg: { ok?: string; err?: string }): never {
  const q = new URLSearchParams(msg as Record<string, string>).toString();
  redirect(`${path}?${q}`);
}

// ───────── Orders ─────────
const STATUSES: OrderStatus[] = ["paid", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];

export async function updateOrderStatus(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().safeParse(formData.get("id"));
  const status = z.enum(STATUSES as [OrderStatus, ...OrderStatus[]]).safeParse(formData.get("status"));
  if (!id.success || !status.success) back("/admin/orders", { err: "Invalid status change." });

  // Never let an unpaid order be pushed into a paid state from the admin panel.
  const { error } = await supabase
    .from("orders")
    .update({ status: status.data })
    .eq("id", id.data)
    .not("paid_at", "is", null);
  if (error) back("/admin/orders", { err: "Couldn't update that order." });
  revalidatePath("/admin/orders");
  back("/admin/orders", { ok: "Order updated." });
}

// ───────── Products ─────────
const MAX_IMAGE = 5 * 1024 * 1024;

/** Identify the image by its actual bytes, not the filename or browser-supplied type. */
async function sniffImage(file: File): Promise<{ ext: string; type: string } | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", type: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", type: "image/png" };
  const ascii = String.fromCharCode(...b);
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return { ext: "webp", type: "image/webp" };
  return null;
}

const ProductForm = z.object({
  id: z.union([z.literal(""), z.uuid()]),
  name: z.string().trim().min(1, "Name is required.").max(80),
  description: z.string().trim().max(500),
  price: z.string(),
  sort: z.coerce.number().int().min(-1000).max(1000),
  active: z.boolean(),
});

export async function saveProduct(formData: FormData) {
  const { supabase } = await requireAdmin();
  const parsed = ProductForm.safeParse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    description: formData.get("description") ?? "",
    price: formData.get("price") ?? "",
    sort: formData.get("sort") || 0,
    active: formData.get("active") === "on",
  });
  if (!parsed.success) back("/admin/products", { err: parsed.error.issues[0]?.message ?? "Check the form." });
  const p = parsed.data;
  const price_cents = parseMoneyToCents(p.price);
  if (!price_cents || price_cents <= 0) back("/admin/products", { err: "Enter a price like 4.50." });

  let image_path: string | undefined;
  const file = formData.get("image");
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_IMAGE) back("/admin/products", { err: "Photos must be 5 MB or smaller." });
    const kind = await sniffImage(file);
    if (!kind) back("/admin/products", { err: "Photos must be JPG, PNG or WebP." });
    image_path = `${crypto.randomUUID()}.${kind.ext}`;
    const { error } = await supabase.storage
      .from("product-images")
      .upload(image_path, file, { contentType: kind.type, upsert: false, cacheControl: "31536000" });
    if (error) back("/admin/products", { err: "Photo upload failed." });
  }

  const row = { name: p.name, description: p.description, price_cents, sort: p.sort, active: p.active, ...(image_path ? { image_path } : {}) };

  if (p.id) {
    const { data: old } = await supabase.from("products").select("image_path").eq("id", p.id).single();
    const { error } = await supabase.from("products").update(row).eq("id", p.id);
    if (error) back("/admin/products", { err: "Couldn't save that item." });
    if (image_path && old?.image_path) await supabase.storage.from("product-images").remove([old.image_path]);
  } else {
    const { error } = await supabase.from("products").insert(row);
    if (error) back("/admin/products", { err: "Couldn't add that item." });
  }
  revalidatePath("/");
  revalidatePath("/admin/products");
  back("/admin/products", { ok: p.id ? `Saved ${p.name}.` : `Added ${p.name}.` });
}

export async function deleteProduct(formData: FormData) {
  const { supabase } = await requireAdmin();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) back("/admin/products", { err: "Invalid item." });
  const { data: old } = await supabase.from("products").select("image_path,name").eq("id", id.data).single();
  const { error } = await supabase.from("products").delete().eq("id", id.data);
  if (error) back("/admin/products", { err: "Couldn't delete that item." });
  if (old?.image_path) await supabase.storage.from("product-images").remove([old.image_path]);
  revalidatePath("/");
  revalidatePath("/admin/products");
  back("/admin/products", { ok: `Deleted ${old?.name ?? "item"}.` });
}

// ───────── Settings ─────────
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export async function saveSettings(formData: FormData) {
  const { supabase } = await requireAdmin();
  const err: (m: string) => never = (m) => back("/admin/settings", { err: m });
  const str = (k: string) => String(formData.get(k) ?? "").trim();
  const int = (k: string) => Number.parseInt(str(k), 10);

  const timezone = str("timezone");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }); } catch { err("Unknown time zone."); }

  const fee = parseMoneyToCents(str("delivery_fee") || "0");
  const min = parseMoneyToCents(str("min_order") || "0");
  if (fee === null || min === null) err("Enter amounts like 5.00.");

  const zips = str("delivery_zips").split(/[\s,]+/).filter(Boolean);
  if (zips.some((z) => !/^\d{5}$/.test(z))) err("ZIP codes must be 5 digits, separated by commas or spaces.");

  const phones = str("alert_phones").split(/[\s,]+/).filter(Boolean);
  if (phones.some((p) => !/^\+[1-9]\d{7,14}$/.test(p))) err("Alert phones must look like +14015550123.");
  if (phones.length > 5) err("Use at most 5 alert phone numbers.");

  const hours: Record<string, { open: string; close: string } | null> = {};
  for (let d = 0; d < 7; d++) {
    if (formData.get(`closed_${d}`) === "on") { hours[d] = null; continue; }
    const open = str(`open_${d}`), close = str(`close_${d}`);
    if (!time.safeParse(open).success || !time.safeParse(close).success || open >= close) {
      err("Each open day needs an opening time before its closing time.");
    }
    hours[d] = { open, close };
  }

  const row = {
    shop_name: str("shop_name").slice(0, 60) || "Empanadas",
    timezone,
    accepting_orders: formData.get("accepting_orders") === "on",
    delivery_enabled: formData.get("delivery_enabled") === "on",
    pickup_enabled: formData.get("pickup_enabled") === "on",
    delivery_fee_cents: fee,
    min_order_cents: min,
    delivery_zips: [...new Set(zips)],
    pickup_address: str("pickup_address").slice(0, 200),
    slot_minutes: int("slot_minutes"),
    max_orders_per_slot: int("max_orders_per_slot"),
    lead_time_minutes: int("lead_time_minutes"),
    days_ahead: int("days_ahead"),
    hours,
    alert_phones: [...new Set(phones)],
    updated_at: new Date().toISOString(),
  };
  if (!row.delivery_enabled && !row.pickup_enabled) err("Turn on delivery, pickup, or both.");

  const { error } = await supabase.from("settings").update(row).eq("id", 1);
  if (error) err("Couldn't save: one of the numbers is out of range."); // DB check constraints
  revalidatePath("/");
  back("/admin/settings", { ok: "Settings saved." });
}

// ───────── Logo ─────────
const MAX_LOGO = 2 * 1024 * 1024;

export async function uploadLogo(formData: FormData) {
  const { supabase } = await requireAdmin();
  const file = formData.get("logo");
  if (!(file instanceof File) || file.size === 0) back("/admin/settings", { err: "Choose a logo file first." });
  if (file.size > MAX_LOGO) back("/admin/settings", { err: "The logo must be 2 MB or smaller." });
  // Byte check, not filename: blocks SVG/HTML disguised as images (they can run scripts).
  const kind = await sniffImage(file);
  if (!kind) back("/admin/settings", { err: "The logo must be a PNG, JPG or WebP. SVG isn't accepted." });

  const path = `logo-${crypto.randomUUID()}.${kind.ext}`;
  const { error: upErr } = await supabase.storage
    .from("product-images")
    .upload(path, file, { contentType: kind.type, upsert: false, cacheControl: "31536000" });
  if (upErr) back("/admin/settings", { err: "Logo upload failed." });

  const { data: old } = await supabase.from("settings").select("logo_path").eq("id", 1).single();
  const { error } = await supabase.from("settings").update({ logo_path: path, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) {
    await supabase.storage.from("product-images").remove([path]);
    back("/admin/settings", { err: "Couldn't save the logo. Did you run migration-002-logo.sql?" });
  }
  if (old?.logo_path) await supabase.storage.from("product-images").remove([old.logo_path]);
  revalidatePath("/", "layout");
  back("/admin/settings", { ok: "Logo updated." });
}

export async function removeLogo() {
  const { supabase } = await requireAdmin();
  const { data: old } = await supabase.from("settings").select("logo_path").eq("id", 1).single();
  const { error } = await supabase.from("settings").update({ logo_path: null, updated_at: new Date().toISOString() }).eq("id", 1);
  if (error) back("/admin/settings", { err: "Couldn't remove the logo." });
  if (old?.logo_path) await supabase.storage.from("product-images").remove([old.logo_path]);
  revalidatePath("/", "layout");
  back("/admin/settings", { ok: "Logo removed. The shop name shows instead." });
}

export async function sendTestSms() {
  const { supabase } = await requireAdmin();
  const { data } = await supabase.from("settings").select("alert_phones,shop_name").eq("id", 1).single();
  if (!data?.alert_phones?.length) back("/admin/settings", { err: "Add an alert phone number first." });
  await sendSms(data.alert_phones, `${data.shop_name}: test alert. Order texts will look like this.`);
  back("/admin/settings", { ok: "Test text sent. If it doesn't arrive, check the Twilio console logs." });
}
