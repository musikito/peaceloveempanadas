"use client";

import { useEffect, useMemo, useState } from "react";
import { formatMoney } from "@/lib/money";
import type { PublicSettings } from "@/lib/types";

export type MenuItem = { id: string; name: string; description: string; price_cents: number; image: string | null };
type SlotDay = { date: string; label: string; slots: { start: string; label: string; available: boolean }[] };

const MAX_QTY = 50;
const CART_KEY = "empanadas-cart-v1";

export default function Shop({ menu, settings, slotDays }: { menu: MenuItem[]; settings: PublicSettings; slotDays: SlotDay[] }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const [mode, setMode] = useState<"delivery" | "pickup">(settings.delivery_enabled ? "delivery" : "pickup");
  const [day, setDay] = useState(slotDays.find((d) => d.slots.some((s) => s.available))?.date ?? "");
  const [slot, setSlot] = useState("");
  const [form, setForm] = useState({ name: "", phone: "", email: "", address: "", zip: "", notes: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Keep the cart if the customer cancels checkout and comes back.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CART_KEY) ?? "{}");
      const valid: Record<string, number> = {};
      for (const m of menu) if (Number.isInteger(saved[m.id]) && saved[m.id] > 0) valid[m.id] = Math.min(saved[m.id], MAX_QTY);
      setQty(valid);
    } catch { /* storage unavailable */ }
  }, [menu]);
  useEffect(() => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(qty)); } catch { /* ignore */ }
  }, [qty]);

  const lines = menu.filter((m) => (qty[m.id] ?? 0) > 0);
  const count = lines.reduce((n, m) => n + qty[m.id], 0);
  const subtotal = lines.reduce((n, m) => n + m.price_cents * qty[m.id], 0);
  const fee = mode === "delivery" ? settings.delivery_fee_cents : 0;
  const total = subtotal + fee;
  const daySlots = useMemo(() => slotDays.find((d) => d.date === day)?.slots ?? [], [slotDays, day]);

  const set = (id: string, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(MAX_QTY, n)) }));
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value })),
  });

  const problem = (() => {
    if (!settings.accepting_orders) return "We're not taking orders right now.";
    if (count === 0) return "Add at least one empanada.";
    if (subtotal < settings.min_order_cents) return `The minimum order is ${formatMoney(settings.min_order_cents)}.`;
    if (!slot) return `Choose a ${mode} time.`;
    if (!form.name.trim() || !form.phone.trim()) return "Add your name and phone number.";
    if (mode === "delivery" && (!form.address.trim() || !form.zip.trim())) return "Add your delivery address and ZIP code.";
    if (mode === "delivery" && settings.delivery_zips.length && !settings.delivery_zips.includes(form.zip.trim()))
      return "We don't deliver to that ZIP code yet. Choose pickup instead.";
    return "";
  })();

  async function checkout() {
    if (problem) return setError(problem);
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: lines.map((m) => ({ id: m.id, qty: qty[m.id] })),
          fulfillment: mode,
          slot,
          name: form.name,
          phone: form.phone,
          email: form.email,
          address: mode === "delivery" ? form.address : "",
          zip: mode === "delivery" ? form.zip : "",
          notes: form.notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error ?? "Checkout couldn't start. Try again.");
      window.location.href = data.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Checkout couldn't start. Try again.");
      setBusy(false);
    }
  }

  return (
    <main className="shop">
      <section aria-label="Menu">
        {menu.length === 0 ? (
          <p className="empty">The menu is being updated. Check back soon.</p>
        ) : (
          <div className="menu">
            {menu.map((m) => {
              const n = qty[m.id] ?? 0;
              return (
                <article className="item" key={m.id}>
                  <div className="item-photo">
                    {m.image ? <img src={m.image} alt={m.name} loading="lazy" /> : <span>No photo yet</span>}
                  </div>
                  <div className="item-row">
                    <h3>{m.name}</h3>
                    <span className="price">{formatMoney(m.price_cents)}</span>
                  </div>
                  {m.description && <p className="item-desc">{m.description}</p>}
                  <div className="stepper" role="group" aria-label={`Quantity of ${m.name}`}>
                    <button type="button" onClick={() => set(m.id, n - 1)} disabled={n === 0} aria-label={`Remove one ${m.name}`}>−</button>
                    <output aria-live="polite">{n}</output>
                    <button type="button" onClick={() => set(m.id, n + 1)} disabled={n >= MAX_QTY || !settings.accepting_orders} aria-label={`Add one ${m.name}`}>+</button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <aside className="panel" id="order" aria-label="Your order">
        <h2>Your order</h2>
        {lines.length === 0 ? (
          <p className="empty">Nothing yet. Use + to add empanadas.</p>
        ) : (
          <ul className="lines">
            {lines.map((m) => (
              <li key={m.id}><span>{qty[m.id]} × {m.name}</span><span>{formatMoney(m.price_cents * qty[m.id])}</span></li>
            ))}
            {fee > 0 && <li><span>Delivery</span><span>{formatMoney(fee)}</span></li>}
            <li className="total"><span>Total</span><span>{formatMoney(total)}</span></li>
          </ul>
        )}

        {settings.delivery_enabled && settings.pickup_enabled && (
          <div className="toggle" role="group" aria-label="Delivery or pickup">
            <button type="button" aria-pressed={mode === "delivery"} onClick={() => setMode("delivery")}>Delivery</button>
            <button type="button" aria-pressed={mode === "pickup"} onClick={() => setMode("pickup")}>Pickup</button>
          </div>
        )}
        {mode === "pickup" && settings.pickup_address && <p className="hint">Pick up at {settings.pickup_address}</p>}

        {slotDays.length === 0 ? (
          <p className="hint">No times are open right now.</p>
        ) : (
          <div className="row2">
            <label className="field">
              <span>Day</span>
              <select className="input" value={day} onChange={(e) => { setDay(e.target.value); setSlot(""); }}>
                {slotDays.map((d) => <option key={d.date} value={d.date}>{d.label}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Time</span>
              <select className="input" value={slot} onChange={(e) => setSlot(e.target.value)}>
                <option value="">Choose…</option>
                {daySlots.map((s) => (
                  <option key={s.start} value={s.start} disabled={!s.available}>{s.label}{s.available ? "" : " (full)"}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        <label className="field"><span>Name</span><input className="input" autoComplete="name" maxLength={80} {...field("name")} /></label>
        <div className="row2">
          <label className="field"><span>Phone</span><input className="input" type="tel" autoComplete="tel" maxLength={20} {...field("phone")} /></label>
          <label className="field"><span>Email <small>(for receipt)</small></span><input className="input" type="email" autoComplete="email" maxLength={120} {...field("email")} /></label>
        </div>

        {mode === "delivery" && (
          <>
            <label className="field">
              <span>Delivery address</span>
              <textarea className="input" autoComplete="street-address" maxLength={300} placeholder="Street, apartment, city" {...field("address")} />
            </label>
            <label className="field"><span>ZIP code</span><input className="input" inputMode="numeric" autoComplete="postal-code" maxLength={5} {...field("zip")} /></label>
          </>
        )}
        <label className="field">
          <span>Notes <small>(optional)</small></span>
          <textarea className="input" maxLength={300} placeholder={mode === "delivery" ? "Gate code, where to leave it…" : "Anything we should know"} {...field("notes")} />
        </label>

        <button className="pay" type="button" onClick={checkout} disabled={busy || !settings.accepting_orders || count === 0}>
          {busy ? "Opening checkout…" : count ? `Pay ${formatMoney(total)}` : "Pay"}
        </button>
        {error ? <p className="err" role="alert">{error}</p> : <p className="hint">Card, Apple Pay, Google Pay or Cash App Pay.</p>}
      </aside>

      {count > 0 && (
        <a className="cart-bar" href="#order"><span>{count} in your order</span><span>{formatMoney(total)}</span></a>
      )}
    </main>
  );
}
