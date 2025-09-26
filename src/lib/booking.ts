import pool from '../lib/db';

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
