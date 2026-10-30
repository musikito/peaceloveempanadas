import "server-only";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { supabaseService } from "@/lib/supabase/admin";
import type { Settings } from "@/lib/types";

export type Slot = { start: string; label: string; available: boolean };
export type SlotDay = { date: string; label: string; slots: Slot[] };

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** All bookable slots from now to `days_ahead`, with capacity applied. */
export async function getSlotDays(s: Settings, now = new Date()): Promise<SlotDay[]> {
  const tz = s.timezone;
  const earliest = now.getTime() + s.lead_time_minutes * 60_000;
  const todayLocal = formatInTimeZone(now, tz, "yyyy-MM-dd");
  const noon = new Date(`${todayLocal}T12:00:00Z`);

  const days: { date: string; starts: Date[] }[] = [];
  for (let i = 0; i <= s.days_ahead; i++) {
    const d = new Date(noon.getTime() + i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    const hours = s.hours?.[String(d.getUTCDay())];
    if (!hours?.open || !hours?.close) continue;

    const open = toMinutes(hours.open);
    const close = toMinutes(hours.close);
    const starts: Date[] = [];
    for (let m = open; m + s.slot_minutes <= close; m += s.slot_minutes) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const start = fromZonedTime(`${date}T${hh}:${mm}:00`, tz);
      if (start.getTime() >= earliest) starts.push(start);
    }
    if (starts.length) days.push({ date, starts });
  }
  if (!days.length) return [];

  const from = days[0].starts[0];
  const last = days[days.length - 1].starts;
  const to = new Date(last[last.length - 1].getTime() + 1000);
  const { data } = await supabaseService().rpc("slot_usage", {
    p_from: from.toISOString(),
    p_to: to.toISOString(),
  });
  const used = new Map<number, number>();
  for (const r of (data ?? []) as { slot_start: string; used: number }[]) {
    used.set(new Date(r.slot_start).getTime(), r.used);
  }

  return days.map(({ date, starts }) => ({
    date,
    label: formatInTimeZone(starts[0], tz, "EEE, MMM d"),
    slots: starts.map((st) => ({
      start: st.toISOString(),
      label: formatInTimeZone(st, tz, "h:mm a"),
      available: (used.get(st.getTime()) ?? 0) < s.max_orders_per_slot,
    })),
  }));
}

/** True if `iso` is exactly one of the currently offered slot start times. */
export function isOfferedSlot(days: SlotDay[], iso: string): boolean {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return false;
  return days.some((d) => d.slots.some((s) => new Date(s.start).getTime() === t));
}

export function formatSlot(iso: string, tz: string): string {
  return formatInTimeZone(new Date(iso), tz, "EEE MMM d, h:mm a");
}
