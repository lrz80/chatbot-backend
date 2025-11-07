// src/lib/availability.ts
import fetch from "node-fetch";

export type AvailabilityQuery = {
  date: string;       // YYYY-MM-DD (TZ del tenant)
  time?: string;      // HH:mm (24h)
  service?: string;
  duration_min?: number;
};

export type AvailabilityResult = {
  ok: boolean;
  available?: boolean;
  remaining?: number;
  capacity?: number;
  next_slots?: Array<{ start: string; remaining?: number }>;
  booking_link?: string;
  raw?: unknown;
  error?: string;
};

/** Forma esperada (mínima) del API externo de disponibilidad */
type BookingAPIResponse = {
  ok?: boolean;
  available?: boolean;
  remaining?: number;
  capacity?: number;
  next_slots?: Array<{ start: string; remaining?: number }>;
  booking_link?: string;
  [k: string]: unknown;
};

/** Type guard para convertir `unknown` → BookingAPIResponse de forma segura */
function looksLikeBookingAPIResponse(x: unknown): x is BookingAPIResponse {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;

  // Chequeos suaves: solo validamos tipos básicos si existen
  const okType =
    o.ok === undefined || typeof o.ok === "boolean";
  const availableType =
    o.available === undefined || typeof o.available === "boolean";
  const remainingType =
    o.remaining === undefined || typeof o.remaining === "number";
  const capacityType =
    o.capacity === undefined || typeof o.capacity === "number";
  const bookingLinkType =
    o.booking_link === undefined || typeof o.booking_link === "string";

  const nextSlotsType =
    o.next_slots === undefined ||
    (Array.isArray(o.next_slots) &&
      o.next_slots.every(
        (s) =>
          s &&
          typeof s === "object" &&
          typeof (s as any).start === "string" &&
          ( (s as any).remaining === undefined || typeof (s as any).remaining === "number" )
      ));

  return okType && availableType && remainingType && capacityType && bookingLinkType && nextSlotsType;
}

export async function checkAvailability(tenant: any, q: AvailabilityQuery): Promise<AvailabilityResult> {
  try {
    // Lee settings.booking ya sea como objeto o como JSON string
    const cfgRoot = tenant?.settings && typeof tenant.settings === "string"
      ? JSON.parse(tenant.settings)
      : tenant?.settings;

    const cfg = cfgRoot?.booking;
    if (!cfg?.enabled || !cfg?.base_url || !cfg?.availability_endpoint) {
      return { ok: false, error: "booking_not_configured" };
    }

    const url =
      cfg.base_url.replace(/\/+$/, "") + "/" + String(cfg.availability_endpoint).replace(/^\/+/, "");

    const headers: Record<string, string> = { "Content-Type": "application/json" };

    // Auth opcional
    if (cfg.auth?.type === "bearer" && cfg.auth?.token) {
      headers["Authorization"] = `Bearer ${cfg.auth.token}`;
    } else if (cfg.auth?.type === "header" && cfg.auth?.header_name && cfg.auth?.token) {
      headers[String(cfg.auth.header_name)] = String(cfg.auth.token);
    }

    // Timeout con AbortController
    const controller = new AbortController();
    const toMs = Number(cfg.timeout_ms || 4000);
    const timer = setTimeout(() => controller.abort(), toMs);

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(q),
      signal: controller.signal as any, // node-fetch v2 acepta AbortController
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      return { ok: false, error: `http_${resp.status}` };
    }

    // json() es unknown en TS estricto → validamos
    const raw: unknown = await resp.json();

    if (!looksLikeBookingAPIResponse(raw)) {
      return { ok: false, error: "invalid_response_shape", raw };
    }

    const data = raw as BookingAPIResponse;

    return {
      ok: Boolean(data.ok ?? true),
      available: Boolean(data.available),
      remaining: typeof data.remaining === "number" ? data.remaining : undefined,
      capacity: typeof data.capacity === "number" ? data.capacity : undefined,
      next_slots: Array.isArray(data.next_slots) ? data.next_slots : undefined,
      booking_link: typeof data.booking_link === "string" ? data.booking_link : undefined,
      raw,
    };
  } catch (e: unknown) {
    const err = e as { name?: string; message?: string };
    return { ok: false, error: err?.name === "AbortError" ? "timeout" : "exception" };
  }
}
