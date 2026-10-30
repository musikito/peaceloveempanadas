import { NextResponse } from "next/server";
import { z } from "zod";
import { supabaseService } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { getSlotDays, isOfferedSlot, formatSlot } from "@/lib/slots";
import { getStripe } from "@/lib/stripe";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { siteUrl } from "@/lib/env";
import type { Product } from "@/lib/types";

export const runtime = "nodejs";

const Body = z.object({
  items: z
    .array(z.object({ id: z.uuid(), qty: z.number().int().min(1).max(50) }))
    .min(1)
    .max(30),
  fulfillment: z.enum(["delivery", "pickup"]),
  slot: z.string().max(40),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().regex(/^\+?[\d\s().-]{7,20}$/, "Enter a valid phone number."),
  email: z.union([z.literal(""), z.email().max(120)]).optional().default(""),
  address: z.string().trim().max(300).optional().default(""),
  zip: z.string().trim().max(10).optional().default(""),
  notes: z.string().trim().max(300).optional().default(""),
});

const fail = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  // Basic CSRF / cross-site abuse guard: only our own pages may start a checkout.
  const origin = req.headers.get("origin");
  if (process.env.NODE_ENV === "production" && origin !== siteUrl()) return fail("Bad origin.", 403);
  if (!req.headers.get("content-type")?.includes("application/json")) return fail("Bad request.", 415);

  const ip = await clientIp();
  if (!(await rateLimit(`checkout:${ip}`, 600, 10))) {
    return fail("Too many checkout attempts. Wait a few minutes and try again.", 429);
  }

  const raw = await req.text();
  if (raw.length > 20_000) return fail("Request too large.", 413);
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return fail("Bad request."); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check your order details.");
  const b = parsed.data;

  const settings = await getSettings();
  if (!settings.accepting_orders) return fail("We're not taking orders right now.", 409);
  if (b.fulfillment === "delivery" && !settings.delivery_enabled) return fail("Delivery isn't available right now.");
  if (b.fulfillment === "pickup" && !settings.pickup_enabled) return fail("Pickup isn't available right now.");

  if (b.fulfillment === "delivery") {
    if (!b.address) return fail("Add your delivery address.");
    if (!/^\d{5}$/.test(b.zip)) return fail("Enter a 5-digit ZIP code.");
    if (settings.delivery_zips.length && !settings.delivery_zips.includes(b.zip)) {
      return fail("We don't deliver to that ZIP code yet. Choose pickup instead.");
    }
  }

  // Merge duplicate lines, then price everything from the DATABASE — never from the browser.
  const wanted = new Map<string, number>();
  for (const i of b.items) wanted.set(i.id, Math.min(50, (wanted.get(i.id) ?? 0) + i.qty));

  const db = supabaseService();
  const { data: rows, error: prodErr } = await db
    .from("products")
    .select("id,name,price_cents,active")
    .in("id", [...wanted.keys()]);
  if (prodErr) return fail("Couldn't load the menu. Try again.", 500);
  const products = (rows ?? []) as Pick<Product, "id" | "name" | "price_cents" | "active">[];
  if (products.length !== wanted.size || products.some((p) => !p.active)) {
    return fail("Part of your order is no longer on the menu. Refresh the page and try again.", 409);
  }

  const items = products.map((p) => ({
    product_id: p.id,
    name: p.name,
    unit_price_cents: p.price_cents,
    qty: wanted.get(p.id)!,
  }));
  const subtotal = items.reduce((n, i) => n + i.unit_price_cents * i.qty, 0);
  if (subtotal < settings.min_order_cents) return fail("Your order is below the minimum.");
  const fee = b.fulfillment === "delivery" ? settings.delivery_fee_cents : 0;
  const total = subtotal + fee;

  // The slot must be one we're actually offering right now (hours, lead time, alignment).
  const days = await getSlotDays(settings);
  if (!isOfferedSlot(days, b.slot)) return fail("That time is no longer available. Choose another.", 409);
  const slotIso = new Date(b.slot).toISOString();

  // Stripe Checkout sessions must live at least 30 minutes. Hold the slot just past that.
  const sessionExpires = Math.floor(Date.now() / 1000) + 30 * 60 + 30;
  const orderExpires = new Date((sessionExpires + 60) * 1000).toISOString();

  const { data: orderId, error: rpcErr } = await db.rpc("create_pending_order", {
    p_order: {
      fulfillment: b.fulfillment,
      customer_name: b.name,
      customer_phone: b.phone,
      customer_email: b.email,
      address: b.fulfillment === "delivery" ? b.address : "",
      address_notes: b.notes,
      zip: b.fulfillment === "delivery" ? b.zip : "",
      slot_start: slotIso,
      subtotal_cents: subtotal,
      delivery_fee_cents: fee,
      total_cents: total,
      expires_at: orderExpires,
    },
    p_items: items,
    p_max_per_slot: settings.max_orders_per_slot,
  });
  if (rpcErr) {
    if (rpcErr.message.includes("SLOT_FULL")) return fail("That time just filled up. Choose another.", 409);
    console.error("create_pending_order", rpcErr.message);
    return fail("Couldn't create your order. Try again.", 500);
  }

  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        // No payment_method_types: Stripe shows every method enabled in your Dashboard
        // (cards, Apple Pay, Google Pay, Cash App Pay).
        line_items: [
          ...items.map((i) => ({
            quantity: i.qty,
            price_data: { currency: "usd", unit_amount: i.unit_price_cents, product_data: { name: i.name } },
          })),
          ...(fee > 0
            ? [{ quantity: 1, price_data: { currency: "usd", unit_amount: fee, product_data: { name: "Delivery" } } }]
            : []),
        ],
        customer_email: b.email || undefined,
        client_reference_id: orderId as string,
        metadata: { order_id: orderId as string },
        payment_intent_data: {
          metadata: { order_id: orderId as string },
          description: `${settings.shop_name} order — ${b.fulfillment} ${formatSlot(slotIso, settings.timezone)}`,
        },
        expires_at: sessionExpires,
        success_url: `${siteUrl()}/order/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl()}/?canceled=1`,
      },
      { idempotencyKey: `order-${orderId}` }
    );

    await db.from("orders").update({ stripe_session_id: session.id }).eq("id", orderId);
    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error("stripe session", e instanceof Error ? e.message : e);
    await db.from("orders").update({ status: "cancelled" }).eq("id", orderId); // release the slot
    return fail("Payment couldn't start. Try again.", 502);
  }
}
