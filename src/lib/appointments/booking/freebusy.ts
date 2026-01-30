// src/lib/appointments/booking/freebusy.ts

type BusyBlock = { startISO: string; endISO: string };

function mapBusy(arr: any[]): BusyBlock[] {
  return arr
    .filter((b: any) => b?.start && b?.end)
    .map((b: any) => ({ startISO: String(b.start), endISO: String(b.end) }));
}

export function extractBusyBlocks(
  fb: any,
  calendarId?: string
): BusyBlock[] {
  const calendars = fb?.calendars;

  // 1) Si sabemos el calendarId consultado, úsalo SIEMPRE primero
  if (calendarId && calendars && typeof calendars === "object") {
    const byId = calendars?.[calendarId]?.busy;
    if (Array.isArray(byId)) return mapBusy(byId);
  }

  // 2) Luego intenta primary
  if (calendars && typeof calendars === "object") {
    const primaryBusy = calendars?.primary?.busy;
    if (Array.isArray(primaryBusy)) return mapBusy(primaryBusy);

    // 3) fallback: cualquier key que tenga busy array
    for (const key of Object.keys(calendars)) {
      const anyBusy = calendars?.[key]?.busy;
      if (Array.isArray(anyBusy)) return mapBusy(anyBusy);
    }
  }

  // 4) fallback defensivo si tu wrapper devuelve directamente fb.busy
  const busy = fb?.busy;
  if (Array.isArray(busy)) return mapBusy(busy);

  return [];
}
