// src/lib/appointments/booking/freebusy.ts

export type BusyBlock = { start: string; end: string };

function mapBusy(arr: any[]): BusyBlock[] {
  return (arr || [])
    .filter((b: any) => b?.start && b?.end)
    .map((b: any) => ({ start: String(b.start), end: String(b.end) }));
}

export function extractBusyBlocks(fb: any, calendarId?: string): BusyBlock[] {
  // 🔥 Si freeBusy está degradado, NO confíes en busy vacío
  if (fb?.degraded) return [];

  const calendars = fb?.calendars;
  if (!calendars || typeof calendars !== "object") {
    const busy = fb?.busy;
    return Array.isArray(busy) ? mapBusy(busy) : [];
  }

  // Helper: obtiene busy de una key (solo si array)
  const getBusy = (key: string) => {
    const arr = calendars?.[key]?.busy;
    return Array.isArray(arr) ? mapBusy(arr) : null;
  };

  // 1) Si te pidieron calendarId, úsalo (aunque sea [])
  if (calendarId) {
    const b = getBusy(calendarId);
    if (b) return b;
  }

  // 2) Si existe primary, úsalo
  if (Object.prototype.hasOwnProperty.call(calendars, "primary")) {
    const b = getBusy("primary");
    if (b) return b;
  }

  // 3) Si hay exactamente 1 calendario, úsalo
  const keys = Object.keys(calendars);
  if (keys.length === 1) {
    const b = getBusy(keys[0]);
    if (b) return b;
  }

  // 4) ✅ Busca primero uno que tenga busy NO vacío
  for (const key of keys) {
    const raw = calendars?.[key]?.busy;
    if (Array.isArray(raw) && raw.length > 0) return mapBusy(raw);
  }

  // 5) Si todos están vacíos, devuelve []
  return [];
}

