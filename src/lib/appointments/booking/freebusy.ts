// src/lib/appointments/booking/freebusy.ts

export type BusyBlock = { start: string; end: string };

function mapBusy(arr: any[]): BusyBlock[] {
  return (arr || [])
    .filter((b: any) => b?.start && b?.end)
    .map((b: any) => ({ start: String(b.start), end: String(b.end) }));
}

export function extractBusyBlocks(fb: any, calendarId?: string): BusyBlock[] {
  const calendars = fb?.calendars;

  // 1) calendarId pedido
  if (calendarId && calendars && typeof calendars === "object") {
    const byId = calendars?.[calendarId]?.busy;
    if (Array.isArray(byId)) return mapBusy(byId);
  }

  // 2) primary
  if (calendars && typeof calendars === "object") {
    const primaryBusy = calendars?.primary?.busy;
    if (Array.isArray(primaryBusy)) return mapBusy(primaryBusy);

    // 3) cualquier key
    for (const key of Object.keys(calendars)) {
      const anyBusy = calendars?.[key]?.busy;
      if (Array.isArray(anyBusy)) return mapBusy(anyBusy);
    }
  }

  // 4) fallback: fb.busy directo
  const busy = fb?.busy;
  if (Array.isArray(busy)) return mapBusy(busy);

  return [];
}
