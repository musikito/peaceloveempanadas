export function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

/** Parses "12.50" / "$12.5" / "12" into integer cents. Returns null if invalid. */
export function parseMoneyToCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}
