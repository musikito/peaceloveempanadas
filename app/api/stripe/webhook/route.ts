import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { env } from "@/lib/env";
import { supabaseService } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { formatSlot } from "@/lib/slots";
import { formatMoney } from "@/lib/money";
import { sendSms } from "@/lib/twilio";
import type { Order, OrderItem } from "@/lib/types";

export const runtime = "nodejs";

// The ONLY place an order becomes "paid". The success page never marks anything paid,
// because a customer can open that URL without paying.
export async function POST(req: Request) {
  const sig = req.headers.get("stripe-signature");
  if (!sig) return new NextResponse("Missing signature", { status: 400 });

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(await req.text(), sig, env("STRIPE_WEBHOOK_SECRET"));
  } catch {
    return new NextResponse("Invalid signature", { status: 400 });
  }

  const db = supabaseService();
  const session = event.data.object as Stripe.Checkout.Session;

  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      if (session.payment_status !== "paid") break; // async method still processing
      const orderId = session.metadata?.order_id;
      if (!orderId) break;

      const { data: existing } = await db.from("orders").select("total_cents").eq("id", orderId).single();
      if (!existing || existing.total_cents !== session.amount_total) {
        console.error("Amount mismatch or unknown order", orderId, session.amount_total);
        break; // do not mark paid; investigate in Stripe
      }

      const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      // Conditional update makes this idempotent: Stripe retries won't double-notify.
      const { data: updated } = await db
        .from("orders")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          stripe_payment_intent: paymentIntent ?? null,
          customer_email: session.customer_details?.email ?? undefined,
        })
        .eq("id", orderId)
        .eq("stripe_session_id", session.id)
        .in("status", ["pending", "expired"])
        .select("*")
        .maybeSingle();

      if (updated) await notify(updated as Order);
      break;
    }
    case "checkout.session.expired":
    case "checkout.session.async_payment_failed": {
      const orderId = session.metadata?.order_id;
      if (orderId) {
        await db.from("orders").update({ status: "expired" }).eq("id", orderId).eq("status", "pending");
      }
      break;
    }
  }
  return NextResponse.json({ received: true });
}

async function notify(order: Order) {
  try {
    const settings = await getSettings();
    const { data } = await supabaseService().from("order_items").select("name,qty").eq("order_id", order.id);
    const items = ((data ?? []) as Pick<OrderItem, "name" | "qty">[]).map((i) => `${i.qty}x ${i.name}`).join(", ");
    const lines = [
      `New order #${order.order_number} — ${order.fulfillment.toUpperCase()}`,
      formatSlot(order.slot_start, settings.timezone),
      items,
      `Total ${formatMoney(order.total_cents)}`,
      `${order.customer_name} ${order.customer_phone}`,
      order.fulfillment === "delivery" ? `${order.address ?? ""} ${order.zip ?? ""}`.trim() : "",
      order.address_notes ? `Note: ${order.address_notes}` : "",
    ].filter(Boolean);
    await sendSms(settings.alert_phones, lines.join("\n"));
  } catch (e) {
    console.error("notify failed", e instanceof Error ? e.message : e);
  }
}
