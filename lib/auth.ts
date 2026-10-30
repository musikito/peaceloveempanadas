import "server-only";
import { redirect } from "next/navigation";
import { supabaseUser } from "@/lib/supabase/server";

/**
 * Verifies the caller is a logged-in admin. Call at the top of EVERY admin page
 * and server action — middleware alone is not enough (server actions can be
 * invoked directly by POST). RLS in the database is the final line of defense.
 */
export async function requireAdmin() {
  const supabase = await supabaseUser();
  const { data: { user } } = await supabase.auth.getUser(); // validates the JWT with Supabase
  if (!user) redirect("/admin/login");

  const { data: isAdmin, error } = await supabase.rpc("is_admin");
  if (error || isAdmin !== true) {
    await supabase.auth.signOut();
    redirect("/admin/login?error=not_admin");
  }
  return { supabase, user };
}
