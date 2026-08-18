// backend/src/lib/tenants/resolveTenantFromInbound.ts

import type { Pool } from "pg";
import { normalizeToNumber } from "../whatsapp/normalize";

type Origen = "twilio" | "meta";

export type ResolveTenantContext = {
  tenant?: any;
  canal?: string;
  origen?: Origen;
};

function extractBookingUrlFromLinks(
  links: unknown
): string | null {
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

function normalizeResolvedTenant(
  row: any
): any | null {
  if (!row || typeof row !== "object") {
    return null;
  }

  const settings =
    row.settings && typeof row.settings === "object"
      ? row.settings
      : {};

  const settingsBooking =
    settings.booking &&
    typeof settings.booking === "object"
      ? settings.booking
      : {};

  const links =
    row.links && typeof row.links === "object"
      ? row.links
      : {};

  const linksBookingUrl =
    extractBookingUrlFromLinks(links);

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
  const {
    pool,
    toRaw,
    origen,
    context,
  } = opts;

  /**
   * Si el caller ya resolvió el tenant,
   * usamos ese directamente.
   */
  const ctxTenant = context?.tenant;

  if (ctxTenant) {
    return normalizeResolvedTenant(ctxTenant);
  }

  try {
    /**
     * =========================================================
     * TWILIO
     * =========================================================
     *
     * To:
     * whatsapp:+1863...
     */
    if (origen === "twilio") {
      const { numeroSinMas } =
        normalizeToNumber(
          String(toRaw || "")
        );

      const toDigits = numeroSinMas;

      if (!toDigits) {
        console.warn(
          "[RESOLVE_TENANT_FROM_INBOUND][TWILIO] To inválido:",
          toRaw
        );

        return null;
      }

      const tenantRes =
        await pool.query(
          `
          SELECT *
          FROM tenants
          WHERE REGEXP_REPLACE(
                  REGEXP_REPLACE(
                    LOWER(COALESCE(twilio_number, '')),
                    '^(whatsapp:|tel:)',
                    ''
                  ),
                  '[^0-9]',
                  '',
                  'g'
                ) = $1
          LIMIT 1
          `,
          [toDigits]
        );

      const row =
        tenantRes.rows[0] || null;

      const tenant =
        normalizeResolvedTenant(row);

      console.log(
        "[RESOLVE_TENANT_FROM_INBOUND][TWILIO]",
        {
          tenantId:
            tenant?.id ?? null,

          toRaw,

          twilioNumber:
            tenant?.twilio_number ??
            null,
        }
      );

      return tenant;
    }

    /**
     * =========================================================
     * META CLOUD API
     * =========================================================
     *
     * whatsapp-cloudapi.ts construye:
     *
     * To: whatsapp:{phone_number_id}
     *
     * Ejemplo:
     * whatsapp:553535851181088
     *
     * Aquí NO buscamos por teléfono E.164.
     * Buscamos por el identificador interno
     * phone_number_id entregado por Meta.
     */
    if (origen === "meta") {
      const raw = String(
        toRaw || ""
      ).trim();

      const phoneNumberId =
        raw
          .replace(/^whatsapp:/i, "")
          .trim();

      if (!phoneNumberId) {
        console.warn(
          "[RESOLVE_TENANT_FROM_INBOUND][META] Falta phone_number_id.",
          {
            toRaw,
          }
        );

        return null;
      }

      const tenantRes =
        await pool.query(
          `
          SELECT *
          FROM tenants
          WHERE whatsapp_phone_number_id::text = $1
          LIMIT 1
          `,
          [phoneNumberId]
        );

      const row =
        tenantRes.rows[0] || null;

      const tenant =
        normalizeResolvedTenant(row);

      console.log(
        "[RESOLVE_TENANT_FROM_INBOUND][META]",
        {
          tenantId:
            tenant?.id ?? null,

          phoneNumberId,

          whatsappMode:
            tenant?.whatsapp_mode ??
            null,

          whatsappStatus:
            tenant?.whatsapp_status ??
            null,
        }
      );

      return tenant;
    }

    console.warn(
      "[RESOLVE_TENANT_FROM_INBOUND] Origen desconocido:",
      origen
    );

    return null;
  } catch (e: any) {
    console.warn(
      "⚠️ resolveTenantFromInbound failed:",
      {
        origen,
        toRaw,
        err:
          e?.message || e,
      }
    );

    return null;
  }
}