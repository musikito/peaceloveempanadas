import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { formatMoney } from "@/lib/money";
import { formatSlot } from "@/lib/slots";
import type { Order, OrderItem, OrderStatus } from "@/lib/types";
import { updateOrderStatus } from "../actions";
import Flash from "../flash";

const NEXT: OrderStatus[] = ["paid", "preparing", "ready", "out_for_delivery", "completed", "cancelled"];
const label = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

type Row = Order & { order_items: Pick<OrderItem, "name" | "qty">[] };

export default async function Orders({ searchParams }: { searchParams: Promise<{ view?: string; ok?: string; err?: string }> }) {
  const { view = "open", ok, err } = await searchParams;
  const { supabase } = await requireAdmin();
  const settings = await getSettings();

  let q = supabase.from("orders").select("*, order_items(name,qty)");
  if (view === "open") {
    q = q.in("status", ["paid", "preparing", "ready", "out_for_delivery"]).order("slot_start").limit(200);
  } else if (view === "unpaid") {
    q = q.in("status", ["pending", "expired"]).order("created_at", { ascending: false }).limit(100);
  } else {
    q = q.not("paid_at", "is", null).order("created_at", { ascending: false }).limit(200);
  }
  const { data } = await q;
  const orders = (data ?? []) as Row[];

  const tabs = [["open", "To make"], ["all", "All paid"], ["unpaid", "Abandoned checkouts"]];

  return (
    <>
      <h1>Orders</h1>
      <Flash ok={ok} err={err} />
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {tabs.map(([v, l]) => (
          <Link key={v} href={`/admin/orders?view=${v}`} className={`btn ${view === v ? "" : "ghost"}`}>{l}</Link>
        ))}
      </p>

      {orders.length === 0 ? (
        <p className="empty">{view === "open" ? "Nothing to make right now." : "No orders here."}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>When</th><th>Customer</th><th>Items</th><th className="num">Total</th><th>Status</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_number}</td>
                  <td>
                    <strong>{o.fulfillment === "delivery" ? "Delivery" : "Pickup"}</strong><br />
                    {formatSlot(o.slot_start, settings.timezone)}
                  </td>
                  <td>
                    {o.customer_name}<br />
                    <a href={`tel:${o.customer_phone.replace(/[^\d+]/g, "")}`}>{o.customer_phone}</a>
                    {o.fulfillment === "delivery" && (
                      <>
                        <br />
                        <a target="_blank" rel="noopener noreferrer"
                           href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${o.address ?? ""} ${o.zip ?? ""}`)}`}>
                          {o.address} {o.zip}
                        </a>
                      </>
                    )}
                    {o.address_notes && <><br /><em>{o.address_notes}</em></>}
                  </td>
                  <td>{o.order_items.map((i) => `${i.qty}× ${i.name}`).join(", ")}</td>
                  <td className="num">{formatMoney(o.total_cents)}</td>
                  <td>
                    {o.paid_at ? (
                      <form action={updateOrderStatus} style={{ display: "flex", gap: 6 }}>
                        <input type="hidden" name="id" value={o.id} />
                        <select className="input" name="status" defaultValue={o.status} aria-label={`Status of order ${o.order_number}`}>
                          {NEXT.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                        </select>
                        <button className="btn" type="submit">Update</button>
                      </form>
                    ) : (
                      <span className={`badge ${o.status}`}>{label(o.status)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
