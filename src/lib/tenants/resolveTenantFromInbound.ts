// backend/src/lib/tenants/resolveTenantFromInbound.ts
import type { Pool } from "pg";
import { normalizeToNumber } from "../whatsapp/normalize";

type Origen = "twilio" | "meta";

export type ResolveTenantContext = {
  tenant?: any;
  canal?: string;
  origen?: Origen;
};

function extractBookingUrlFromLinks(links: unknown): string | null {
  if (!links || typeof links !== "object") {
    return null;
  }

  const obj = links as Record<string, unknown>;

  const direct =
    String(
      obj.booking_url ||
      obj.bookingUrl ||
      ""
    ).trim() || null;

  if (direct) {
    return direct;
  }

  const bookingNode =
    obj.booking && typeof obj.booking === "object"
      ? (obj.booking as Record<string, unknown>)
      : null;

  const nested =
    String(
      bookingNode?.booking_url ||
      bookingNode?.bookingUrl ||
      bookingNode?.url ||
      ""
    ).trim() || null;

  if (nested) {
    return nested;
  }

  return null;
}

function normalizeResolvedTenant(row: any): any | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const settings =
    row.settings && typeof row.settings === "object"
      ? row.settings
      : {};

  const settingsBooking =
    settings.booking && typeof settings.booking === "object"
      ? settings.booking
      : {};

  const links =
    row.links && typeof row.links === "object"
      ? row.links
      : {};

  const linksBookingUrl = extractBookingUrlFromLinks(links);

  const normalizedBookingUrl =
    String(
      row.booking_url ||
      row.bookingUrl ||
      settingsBooking.booking_url ||
      linksBookingUrl ||
      ""
    ).trim() || null;

  return {
    ...row,
    booking_url: normalizedBookingUrl,
    settings: {
      ...settings,
      booking: {
        ...settingsBooking,
        booking_url: normalizedBookingUrl,
      },
    },
    links,
  };
}

export async function resolveTenantFromInbound(opts: {
  pool: Pool;
  toRaw: string;
  origen: Origen;
  context?: ResolveTenantContext;
}): Promise<any | null> {
  const { pool, toRaw, origen, context } = opts;

  const ctxTenant = context?.tenant;
  if (ctxTenant) {
    return normalizeResolvedTenant(ctxTenant);
  }

  const { numeroSinMas } = normalizeToNumber(String(toRaw || ""));
  const toDigits = numeroSinMas;

  try {
    if (origen === "twilio") {
      const tenantRes = await pool.query(
        `
        SELECT *
        FROM tenants
        WHERE REGEXP_REPLACE(
                REGEXP_REPLACE(LOWER(COALESCE(twilio_number, '')), '^(whatsapp:|tel:)', ''),
                '[^0-9]',
                '',
                'g'
              ) = $1
        LIMIT 1
        `,
        [toDigits]
      );

      const row = tenantRes.rows[0] || null;

      console.log("[RESOLVE_TENANT_FROM_INBOUND][LINKS_DEBUG]", {
        tenantId: row?.id ?? null,
        links: row?.links ?? null,
      });

      const tenant = normalizeResolvedTenant(row);

      console.log("[RESOLVE_TENANT_FROM_INBOUND][TENANT_BOOKING_DEBUG]", {
        tenantId: tenant?.id ?? null,
        booking_url: tenant?.booking_url ?? null,
        settings_booking_url: tenant?.settings?.booking?.booking_url ?? null,
        links_booking_url: tenant?.links?.booking_url ?? null,
      });

      return tenant;
    }

    return null;
  } catch (e: any) {
    console.warn("⚠️ resolveTenantFromInbound failed:", {
      origen,
      toRaw,
      err: e?.message,
    });
    return null;
  }
}