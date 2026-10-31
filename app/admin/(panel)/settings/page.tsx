import { requireAdmin } from "@/lib/auth";
import type { Settings } from "@/lib/types";
import { saveSettings, sendTestSms, uploadLogo, removeLogo } from "../actions";
import { publicImageUrl } from "@/lib/supabase/admin";
import Flash from "../flash";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dollars = (c: number) => (c / 100).toFixed(2);

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { ok, err } = await searchParams;
  const { supabase } = await requireAdmin();
  const { data } = await supabase.from("settings").select("*").eq("id", 1).single();
  const s = data as Settings;
  const logo = publicImageUrl(s.logo_path ?? null);

  return (
    <>
      <h1>Settings</h1>
      <Flash ok={ok} err={err} />

      <h2 style={{ marginTop: 0 }}>Logo</h2>
      <div className="box logo-admin">
        <div className="logo-preview">
          {logo ? <img src={logo} alt={`${s.shop_name} logo`} /> : <span>No logo yet. The shop name shows in its place.</span>}
        </div>
        <div>
          <form action={uploadLogo}>
            <label className="field">
              <span>{logo ? "Replace logo" : "Upload a logo"} <small>(PNG with a transparent background works best; JPG or WebP also OK, up to 2 MB)</small></span>
              <input className="input" type="file" name="logo" accept="image/png,image/jpeg,image/webp" required />
            </label>
            <button className="btn" type="submit">{logo ? "Replace logo" : "Upload logo"}</button>
          </form>
          {logo && (
            <form action={removeLogo} style={{ marginTop: 8 }}>
              <button className="btn danger" type="submit">Remove logo</button>
            </form>
          )}
        </div>
      </div>

      <form action={saveSettings}>
        <div className="box">
          <label className="check"><input type="checkbox" name="accepting_orders" defaultChecked={s.accepting_orders} /> Taking orders</label>
          <div className="grid-form" style={{ marginTop: 10 }}>
            <label className="field"><span>Shop name</span><input className="input" name="shop_name" maxLength={60} defaultValue={s.shop_name} /></label>
            <label className="field"><span>Time zone</span><input className="input" name="timezone" defaultValue={s.timezone} /></label>
          </div>
        </div>

        <h2>Delivery and pickup</h2>
        <div className="box">
          <label className="check"><input type="checkbox" name="delivery_enabled" defaultChecked={s.delivery_enabled} /> Offer delivery</label>
          <label className="check"><input type="checkbox" name="pickup_enabled" defaultChecked={s.pickup_enabled} /> Offer pickup</label>
          <div className="grid-form" style={{ marginTop: 10 }}>
            <label className="field"><span>Delivery fee ($)</span><input className="input" name="delivery_fee" inputMode="decimal" defaultValue={dollars(s.delivery_fee_cents)} /></label>
            <label className="field"><span>Minimum order ($)</span><input className="input" name="min_order" inputMode="decimal" defaultValue={dollars(s.min_order_cents)} /></label>
          </div>
          <label className="field">
            <span>Delivery ZIP codes <small>(leave empty to deliver anywhere)</small></span>
            <textarea className="input" name="delivery_zips" placeholder="02903, 02906, 02908" defaultValue={s.delivery_zips.join(", ")} />
          </label>
          <label className="field"><span>Pickup address</span><input className="input" name="pickup_address" maxLength={200} defaultValue={s.pickup_address} /></label>
        </div>

        <h2>Time slots</h2>
        <div className="box">
          <div className="grid-form">
            <label className="field"><span>Slot length (minutes)</span><input className="input" type="number" name="slot_minutes" min={10} max={240} defaultValue={s.slot_minutes} /></label>
            <label className="field"><span>Orders per slot</span><input className="input" type="number" name="max_orders_per_slot" min={1} max={100} defaultValue={s.max_orders_per_slot} /></label>
            <label className="field"><span>Notice needed (minutes)</span><input className="input" type="number" name="lead_time_minutes" min={0} max={2880} defaultValue={s.lead_time_minutes} /></label>
            <label className="field"><span>Days customers can book ahead</span><input className="input" type="number" name="days_ahead" min={0} max={60} defaultValue={s.days_ahead} /></label>
          </div>
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table>
              <thead><tr><th>Day</th><th>Opens</th><th>Closes</th><th>Closed</th></tr></thead>
              <tbody>
                {DAYS.map((name, d) => {
                  const h = s.hours?.[String(d)] ?? null;
                  return (
                    <tr key={d}>
                      <td>{name}</td>
                      <td><input className="input" type="time" name={`open_${d}`} defaultValue={h?.open ?? "11:00"} aria-label={`${name} opens`} /></td>
                      <td><input className="input" type="time" name={`close_${d}`} defaultValue={h?.close ?? "20:00"} aria-label={`${name} closes`} /></td>
                      <td><input type="checkbox" name={`closed_${d}`} defaultChecked={!h} aria-label={`Closed on ${name}`} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <h2>Order alerts</h2>
        <div className="box">
          <label className="field">
            <span>Text these numbers for every paid order <small>(format +14015550123, one per line)</small></span>
            <textarea className="input" name="alert_phones" defaultValue={s.alert_phones.join("\n")} />
          </label>
        </div>

        <p><button className="btn" type="submit">Save settings</button></p>
      </form>

      <form action={sendTestSms}><button className="btn ghost" type="submit">Send a test text</button></form>
    </>
  );
}
