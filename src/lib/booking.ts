import pool from '../lib/db';
import crypto from "crypto";

export type BookingConfig = {
  bookingUrl?: string | null;
  apiUrl?: string | null;
  headers?: Record<string, any> | null;
};

export async function getBookingConfig(tenantId: string): Promise<BookingConfig> {
  const { rows } = await pool.query(
    `SELECT links, settings FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (!rows[0]) return {};

  const links = rows[0].links || {};
  const settings = rows[0].settings || {};

  const bookingUrl =
    links.booking_url ??
    settings?.booking?.booking_url ??
    null;

  const apiUrl =
    links.booking_api_url ??
    settings?.availability?.api_url ??
    null;

  const headers =
    links.booking_headers ??
    settings?.availability?.headers ??
    null;

  return { bookingUrl, apiUrl, headers };
}

export async function checkAvailabilityNextClass(
  apiUrl: string,
  headers?: Record<string, any> | null
): Promise<{ hasClass: boolean; whenText?: string }> {
  try {
    const r = await fetch(apiUrl, {
      method: 'GET',
      headers: headers ? Object.fromEntries(Object.entries(headers).map(([k,v]) => [k, String(v)])) : {}
    });
    if (!r.ok) throw new Error(`API ${r.status}`);
    const data = await r.json();

    // ❗️Adapta este parse a tu payload real:
    // Supongamos que la API devuelve array de clases { start, title, available }
    const upcoming = (Array.isArray(data) ? data : data?.classes || [])
      .find((c: any) => c?.available !== false);

    if (upcoming) {
      // Formatea fecha/hora legible (en español)
      const d = new Date(upcoming.start);
      const whenText = d.toLocaleString('es-ES', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true
      });
      return { hasClass: true, whenText };
    }
    return { hasClass: false };
  } catch {
    // No rompas el flujo si falla; deja que el caller haga fallback al link
    return { hasClass: false };
  }
}

function makeIdempotencyKey(args: {
  tenantId: string;
  channel: string;
  customer_phone?: string;
  customer_email?: string;
  start_time: string;
  end_time: string;
}) {
  // ✅ clave por SLOT (y opcionalmente teléfono/email)
  const raw = [
    args.tenantId,
    args.channel,
    (args.customer_phone || "").trim(),
    (args.customer_email || "").trim().toLowerCase(),
    args.start_time,
    args.end_time,
  ].join("|");

  // hash para que no sea enorme
  return "appt_" + crypto.createHash("sha1").update(raw).digest("hex");
}

export async function createPendingAppointmentOrGetExisting(args: {
  tenantId: string;
  channel: string;
  customer_name: string;
  customer_phone?: string;
  customer_email?: string;
  start_time: string;
  end_time: string;
}) {
  const key = makeIdempotencyKey({
    tenantId: args.tenantId,
    channel: args.channel,
    customer_phone: args.customer_phone,
    customer_email: args.customer_email,
    start_time: args.start_time,
    end_time: args.end_time,
  });

  // 1) intenta insertar
  const insert = await pool.query(
    `
    INSERT INTO appointments (
      tenant_id,
      channel,
      customer_name,
      customer_phone,
      customer_email,
      start_time,
      end_time,
      status,
      idempotency_key,
      created_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,NOW(),NOW())
    ON CONFLICT (idempotency_key)
    DO UPDATE SET
      updated_at = NOW(),
      -- si existía un intento fallido, lo “reabre” para reintentar sin fricción:
      status = CASE
        WHEN appointments.status IN ('failed') THEN 'pending'
        ELSE appointments.status
      END,
      error_reason = CASE
        WHEN appointments.status IN ('failed') THEN NULL
        ELSE appointments.error_reason
      END
    RETURNING *;
    `,
    [
      args.tenantId,
      args.channel,
      args.customer_name,
      args.customer_phone || null,
      args.customer_email || null,
      args.start_time,
      args.end_time,
      key,
    ]
  );

  return insert.rows[0] || null;
}