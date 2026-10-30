import Link from "next/link";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { formatMoney } from "@/lib/money";
import { formatSlot } from "@/lib/slots";
import type { Order } from "@/lib/types";

type Totals = { orders: number; revenue_cents: number; items: number };

function boundaries(tz: string, now = new Date()) {
  const today = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const noon = new Date(`${today}T12:00:00Z`);
  const shift = (days: number) => new Date(noon.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  const dow = noon.getUTCDay(); // 0 = Sunday
  const at = (date: string) => fromZonedTime(`${date}T00:00:00`, tz);
  return {
    today: at(today),
    tomorrow: at(shift(1)),
    week: at(shift(-((dow + 6) % 7))), // weeks start Monday
    month: at(`${today.slice(0, 7)}-01`),
    year: at(`${today.slice(0, 4)}-01-01`),
    last30: at(shift(-29)),
    days30: Array.from({ length: 30 }, (_, i) => shift(i - 29)),
  };
}

export default async function Dashboard() {
  const { supabase } = await requireAdmin();
  const settings = await getSettings();
  const tz = settings.timezone;
  const b = boundaries(tz);
  const end = b.tomorrow.toISOString();

  const period = async (from: Date): Promise<Totals> => {
    const { data } = await supabase.rpc("sales_between", { p_from: from.toISOString(), p_to: end });
    const r = (data?.[0] ?? {}) as Partial<Totals>;
    return { orders: r.orders ?? 0, revenue_cents: Number(r.revenue_cents ?? 0), items: r.items ?? 0 };
  };

  const [today, week, month, year, daily, top, upcoming] = await Promise.all([
    period(b.today),
    period(b.week),
    period(b.month),
    period(b.year),
    supabase.rpc("sales_by_day", { p_from: b.last30.toISOString(), p_to: end, p_tz: tz }),
    supabase.rpc("top_products", { p_from: b.month.toISOString(), p_to: end }),
    supabase
      .from("orders")
      .select("id,order_number,status,fulfillment,customer_name,slot_start,total_cents")
      .in("status", ["paid", "preparing", "ready", "out_for_delivery"])
      .gte("slot_start", b.today.toISOString())
      .lt("slot_start", end)
      .order("slot_start")
      .limit(50),
  ]);

  const byDay = new Map<string, number>();
  for (const r of (daily.data ?? []) as { day: string; revenue_cents: number }[]) byDay.set(r.day, Number(r.revenue_cents));
  const series = b.days30.map((d) => ({ d, v: byDay.get(d) ?? 0 }));
  const max = Math.max(1, ...series.map((s) => s.v));

  const cards: [string, Totals][] = [["Today", today], ["This week", week], ["This month", month], ["This year", year]];

  return (
    <>
      <h1>Sales</h1>
      <div className="stats">
        {cards.map(([label, t]) => (
          <div className="stat" key={label}>
            <div className="k">{label}</div>
            <div className="v">{formatMoney(t.revenue_cents)}</div>
            <div className="n">{t.orders} orders · {t.items} empanadas</div>
          </div>
        ))}
      </div>

      <h2>Last 30 days</h2>
      <div className="box">
        <div className="bars" role="img" aria-label="Daily revenue for the last 30 days">
          {series.map((s) => (
            <div key={s.d} style={{ height: `${(s.v / max) * 100}%` }} title={`${s.d}: ${formatMoney(s.v)}`} />
          ))}
        </div>
        <div className="bars-x"><span>{series[0].d}</span><span>Today</span></div>
      </div>

      <h2>Today&apos;s orders</h2>
      {(upcoming.data ?? []).length === 0 ? (
        <p className="empty">No orders scheduled for today yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Time</th><th>#</th><th>Customer</th><th>Type</th><th>Status</th><th className="num">Total</th></tr></thead>
            <tbody>
              {((upcoming.data ?? []) as Order[]).map((o) => (
                <tr key={o.id}>
                  <td>{formatSlot(o.slot_start, tz)}</td>
                  <td>{o.order_number}</td>
                  <td>{o.customer_name}</td>
                  <td>{o.fulfillment === "delivery" ? "Delivery" : "Pickup"}</td>
                  <td><span className={`badge ${o.status}`}>{o.status.replace(/_/g, " ")}</span></td>
                  <td className="num">{formatMoney(o.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p><Link href="/admin/orders">Manage orders</Link></p>

      <h2>Best sellers this month</h2>
      {(top.data ?? []).length === 0 ? (
        <p className="empty">No sales this month yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Empanada</th><th className="num">Sold</th><th className="num">Revenue</th></tr></thead>
            <tbody>
              {((top.data ?? []) as { name: string; qty: number; revenue_cents: number }[]).map((t) => (
                <tr key={t.name}><td>{t.name}</td><td className="num">{t.qty}</td><td className="num">{formatMoney(Number(t.revenue_cents))}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">Totals include delivery fees and count orders by the time they were paid. If you refund an order in Stripe, mark it cancelled here so it drops out of the totals.</p>
    </>
  );
}
