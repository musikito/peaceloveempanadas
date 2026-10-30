import "server-only";
import twilio from "twilio";

/**
 * Sends one SMS to each number. Never throws — a failed text must not break the
 * Stripe webhook (Stripe would retry and we'd risk duplicate processing).
 */
export async function sendSms(to: string[], body: string): Promise<void> {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!sid || !token || !from || to.length === 0) {
    console.warn("Twilio not configured or no alert phones; skipping SMS");
    return;
  }
  const client = twilio(sid, token);
  const sender = from.startsWith("MG") ? { messagingServiceSid: from } : { from };
  await Promise.all(
    to.map((num) =>
      client.messages
        .create({ to: num, body: body.slice(0, 1500), ...sender })
        .catch((e: unknown) => console.error("SMS failed", num, e instanceof Error ? e.message : e))
    )
  );
}
