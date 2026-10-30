import { requireAdmin } from "@/lib/auth";
import { publicImageUrl } from "@/lib/supabase/admin";
import type { Product } from "@/lib/types";
import { saveProduct, deleteProduct } from "../actions";
import Flash from "../flash";

function ProductFields({ p }: { p?: Product }) {
  return (
    <>
      <input type="hidden" name="id" value={p?.id ?? ""} />
      <div className="grid-form">
        <label className="field"><span>Name</span><input className="input" name="name" required maxLength={80} defaultValue={p?.name} /></label>
        <label className="field"><span>Price ($)</span><input className="input" name="price" required inputMode="decimal" placeholder="4.50" defaultValue={p ? (p.price_cents / 100).toFixed(2) : ""} /></label>
        <label className="field"><span>Order on menu</span><input className="input" name="sort" type="number" min={-1000} max={1000} defaultValue={p?.sort ?? 0} /></label>
      </div>
      <label className="field"><span>Description</span><textarea className="input" name="description" maxLength={500} defaultValue={p?.description} /></label>
      <label className="field">
        <span>{p?.image_path ? "Replace photo" : "Photo"} <small>(JPG, PNG or WebP, up to 5 MB)</small></span>
        <input className="input" name="image" type="file" accept="image/jpeg,image/png,image/webp" />
      </label>
      <label className="check"><input type="checkbox" name="active" defaultChecked={p?.active ?? true} /> Show on the menu</label>
    </>
  );
}

export default async function Products({ searchParams }: { searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { ok, err } = await searchParams;
  const { supabase } = await requireAdmin();
  const { data } = await supabase.from("products").select("*").order("sort").order("name");
  const products = (data ?? []) as Product[];

  return (
    <>
      <h1>Menu</h1>
      <Flash ok={ok} err={err} />

      <h2>Add an empanada</h2>
      <form action={saveProduct} className="box">
        <ProductFields />
        <button className="btn" type="submit">Add to menu</button>
      </form>

      <h2>On the menu ({products.length})</h2>
      <div className="box">
        {products.length === 0 && <p className="empty">No items yet. Add your first empanada above.</p>}
        {products.map((p) => {
          const img = publicImageUrl(p.image_path);
          return (
            <div className="prod-admin" key={p.id}>
              {img ? <img className="thumb" src={img} alt={p.name} /> : <div className="thumb" aria-hidden />}
              <div>
                <form action={saveProduct}>
                  <ProductFields p={p} />
                  <button className="btn" type="submit">Save changes</button>
                </form>
                <form action={deleteProduct} style={{ marginTop: 8 }}>
                  <input type="hidden" name="id" value={p.id} />
                  <button className="btn danger" type="submit">Delete {p.name}</button>
                </form>
              </div>
            </div>
          );
        })}
      </div>
      <p className="hint">To pause an item without losing it, uncheck &ldquo;Show on the menu&rdquo; instead of deleting it.</p>
    </>
  );
}
