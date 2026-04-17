// backend/src/lib/tenants/resolveTenantFromInbound.ts
import type { Pool } from "pg";
import { normalizeToNumber } from "../whatsapp/normalize";

type Origen = "twilio" | "meta";

export type ResolveTenantContext = {
  tenant?: any;
  canal?: string;
  origen?: Origen;
};

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

  const normalizedBookingUrl =
    String(
      row.booking_url ||
      row.bookingUrl ||
      settingsBooking.booking_url ||
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

  const { numero, numeroSinMas } = normalizeToNumber(String(toRaw || ""));
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

      const tenant = normalizeResolvedTenant(tenantRes.rows[0] || null);

      console.log("[RESOLVE_TENANT_FROM_INBOUND][TENANT_BOOKING_DEBUG]", {
        tenantId: tenant?.id ?? null,
        booking_url: tenant?.booking_url ?? null,
        settings_booking_url: tenant?.settings?.booking?.booking_url ?? null,
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