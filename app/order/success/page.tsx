import Link from "next/link";
import { getStripe } from "@/lib/stripe";
import { supabaseService } from "@/lib/supabase/admin";
import { getSettings } from "@/lib/settings";
import { formatSlot } from "@/lib/slots";
import { formatMoney } from "@/lib/money";
import type { Order } from "@/lib/types";
import ClearCart from "./clear-cart";

export const dynamic = "force-dynamic";

export default async function Success({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const { session_id } = await searchParams;
  let order: Order | null = null;
  let paid = false;

  if (session_id && /^cs_(test|live)_[A-Za-z0-9]+$/.test(session_id)) {
    try {
      const session = await getStripe().checkout.sessions.retrieve(session_id);
      paid = session.payment_status === "paid";
      const { data } = await supabaseService()
        .from("orders")
        .select("*")
        .eq("stripe_session_id", session.id)
        .maybeSingle();
      order = data as Order | null;
    } catch { /* unknown session */ }
  }
  const settings = await getSettings();

  if (!order) {
    return (
      <main className="confirm">
        <h1>We couldn&apos;t find that order</h1>
        <p>If you paid, you&apos;ll get a receipt by email. <Link href="/">Back to the menu</Link></p>
      </main>
    );
  }

  return (
    <main className="confirm">
      <ClearCart />
      <h1>{paid ? `Order #${order.order_number} is in` : "Your payment is processing"}</h1>
      <p>
        {paid
          ? order.fulfillment === "delivery"
            ? "We'll bring it to you at the time below."
            : "It'll be ready for pickup at the time below."
          : "We'll start on your order as soon as the payment clears."}
      </p>
      <dl>
        <dt>{order.fulfillment === "delivery" ? "Delivery" : "Pickup"}</dt>
        <dd>{formatSlot(order.slot_start, settings.timezone)}</dd>
        {order.fulfillment === "delivery" ? (
          <><dt>Address</dt><dd>{order.address}</dd></>
        ) : (
          settings.pickup_address && <><dt>Where</dt><dd>{settings.pickup_address}</dd></>
        )}
        <dt>Total</dt>
        <dd>{formatMoney(order.total_cents)}</dd>
      </dl>
      <p><Link href="/">Back to the menu</Link></p>
    </main>
  );
}
