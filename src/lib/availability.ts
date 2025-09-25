import fetch from 'node-fetch';

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
  raw?: any;
  error?: string;
};

export async function checkAvailability(tenant: any, q: AvailabilityQuery): Promise<AvailabilityResult> {
  try {
    const cfg = tenant?.settings?.booking || JSON.parse(tenant?.settings || '{}')?.booking;
    if (!cfg?.enabled || !cfg?.base_url || !cfg?.availability_endpoint) {
      return { ok: false, error: 'booking_not_configured' };
    }

    const url = (cfg.base_url.replace(/\/+$/,'') + '/' + cfg.availability_endpoint.replace(/^\/+/, ''));
    const headers: Record<string,string> = { 'Content-Type': 'application/json' };

    if (cfg.auth?.type === 'bearer' && cfg.auth?.token) {
      headers['Authorization'] = `Bearer ${cfg.auth.token}`;
    } else if (cfg.auth?.type === 'header' && cfg.auth?.header_name && cfg.auth?.token) {
      headers[cfg.auth.header_name] = cfg.auth.token;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(cfg.timeout_ms || 4000));

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(q),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) return { ok: false, error: `http_${resp.status}` };
    const data = await resp.json();

    return {
      ok: Boolean(data.ok ?? true),
      available: Boolean(data.available),
      remaining: data.remaining,
      capacity: data.capacity,
      next_slots: data.next_slots,
      booking_link: data.booking_link,
      raw: data
    };
  } catch (e: any) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timeout' : 'exception' };
  }
}
