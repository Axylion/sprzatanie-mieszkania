import webpush from "npm:web-push@3.6.7";
import { createHash, timingSafeEqual } from "node:crypto";
import { deliveryOutcome, pushPayload } from "./events.mjs";

const env = (key: string) => Deno.env.get(key) ?? "";
const api = env("SUPABASE_URL");
const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY");
const secret = env("G19_DELIVERY_SECRET");
const hash = (value: string) => createHash("sha256").update(value).digest();
const allowedHosts = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)?push\.apple\.com|([a-z0-9-]+\.)?notify\.windows\.com)$/;

async function rpc(name: string, body = {}) {
  const response = await fetch(api + "/rest/v1/rpc/g19_" + name, {
    method: "POST", redirect: "error",
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(name + ": " + response.status);
  return await response.json().catch(() => null);
}

Deno.serve(async request => {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!secret || !timingSafeEqual(hash(request.headers.get("x-g19-delivery") || ""), hash(secret))) {
    return new Response(null, { status: 401 });
  }
  try {
    await rpc("db_notification_tick", { p_duty_enabled: env("G19_DUTY_ENABLED") === "true" });
    const publicKey = env("G19_VAPID_PUBLIC_KEY");
    const privateKey = env("G19_VAPID_PRIVATE_KEY");
    const subject = env("G19_VAPID_SUBJECT");
    if (!publicKey || !privateKey || !subject) return Response.json({ pushConfigured: false });
    webpush.setVapidDetails(subject, publicKey, privateKey);
    const batch = await rpc("push_take");
    const outcomes = await Promise.all(batch.map(async (item: { id: string; lease: string; endpoint: string; p256dh: string; auth: string; category: string; kind?: string; target: string; room?: number; message?: string }) => {
      let outcome = "failed";
      const endpoint = new URL(item.endpoint);
      if (endpoint.protocol === "https:" && !endpoint.port && !endpoint.username && !endpoint.password && allowedHosts.test(endpoint.hostname)) {
        try {
          if (item.kind === "manual_duty" && !await rpc("manual_duty_delivery_active", { p_notification: item.id })) {
            await rpc("push_finish", { p_id: item.id, p_lease: item.lease, p_outcome: "failed" });
            return "skipped";
          }
          if (item.kind === "private" && !await rpc("private_delivery_active", { p_notification: item.id })) {
            await rpc("push_finish", { p_id: item.id, p_lease: item.lease, p_outcome: "failed" });
            return "skipped";
          }
          if (item.category === "announcements" &&
              !await rpc("announcement_delivery_active", { p_id: item.id })) {
            await rpc("push_finish", { p_id: item.id, p_lease: item.lease, p_outcome: "failed" });
            return "skipped";
          }
          await webpush.sendNotification({
            endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth }
          }, JSON.stringify(pushPayload(item)), {
            TTL: 1800, timeout: 7000, topic: hash(item.id).toString("base64url").slice(0, 32)
          });
          outcome = "sent";
        } catch (error) {
          outcome = deliveryOutcome((error as { statusCode?: number }).statusCode);
        }
      }
      await rpc("push_finish", { p_id: item.id, p_lease: item.lease, p_outcome: outcome });
      return outcome;
    }));
    const counts = Object.fromEntries(["sent", "retry", "gone", "failed", "skipped"].map(key => [key, outcomes.filter(x => x === key).length]));
    console.info("g19 delivery", counts);
    return Response.json(counts);
  } catch {
    console.error("g19: delivery job failed");
    return new Response(null, { status: 502 });
  }
});
