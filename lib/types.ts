export type DayHours = { open: string; close: string } | null;

export type Settings = {
  id: 1;
  shop_name: string;
  timezone: string;
  accepting_orders: boolean;
  delivery_enabled: boolean;
  pickup_enabled: boolean;
  delivery_fee_cents: number;
  min_order_cents: number;
  delivery_zips: string[];
  pickup_address: string;
  slot_minutes: number;
  max_orders_per_slot: number;
  lead_time_minutes: number;
  days_ahead: number;
  hours: Record<string, DayHours>;
  alert_phones: string[];
  logo_path: string | null;
  updated_at: string;
};

/** Settings fields that are safe to send to the browser (no alert phone numbers). */
export type PublicSettings = Pick<
  Settings,
  | "shop_name"
  | "timezone"
  | "accepting_orders"
  | "delivery_enabled"
  | "pickup_enabled"
  | "delivery_fee_cents"
  | "min_order_cents"
  | "delivery_zips"
  | "pickup_address"
  | "logo_path"
>;

export type Product = {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  image_path: string | null;
  active: boolean;
  sort: number;
  created_at: string;
};

export type OrderStatus =
  | "pending"
  | "paid"
  | "preparing"
  | "ready"
  | "out_for_delivery"
  | "completed"
  | "cancelled"
  | "expired";

export type Order = {
  id: string;
  order_number: number;
  status: OrderStatus;
  fulfillment: "delivery" | "pickup";
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  address: string | null;
  address_notes: string | null;
  zip: string | null;
  slot_start: string;
  subtotal_cents: number;
  delivery_fee_cents: number;
  total_cents: number;
  stripe_session_id: string | null;
  stripe_payment_intent: string | null;
  paid_at: string | null;
  expires_at: string;
  created_at: string;
};

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  name: string;
  unit_price_cents: number;
  qty: number;
};

export const PAID_STATUSES: OrderStatus[] = ["paid", "preparing", "ready", "out_for_delivery", "completed"];
