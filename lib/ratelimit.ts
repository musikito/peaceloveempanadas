import "server-only";
import { headers } from "next/headers";
import { supabaseService } from "@/lib/supabase/admin";

export async function clientIp(): Promise<string> {
  const h = await headers();
  // On Vercel these headers are set by the edge and cannot be spoofed by the client.
  return (h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
}

/** Returns true if the request is allowed. Fails open only if the DB is unreachable. */
export async function rateLimit(key: string, windowSeconds: number, max: number): Promise<boolean> {
  const { data, error } = await supabaseService().rpc("hit_rate_limit", {
    p_key: key,
    p_window_seconds: windowSeconds,
    p_max: max,
  });
  if (error) {
    console.error("rate limit error", error.message);
    return true;
  }
  return data === true;
}
