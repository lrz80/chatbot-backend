// src/lib/appointments/booking/freebusy.ts

export function extractBusyBlocks(fb: any): Array<{ startISO: string; endISO: string }> {
  // Respuesta típica de Google freebusy:
  // { calendars: { primary: { busy: [{ start, end }, ...] } } }
  const calendars = fb?.calendars;

  if (calendars && typeof calendars === "object") {
    // intenta primary primero
    const primaryBusy = calendars?.primary?.busy;
    if (Array.isArray(primaryBusy)) {
      return primaryBusy
        .filter((b: any) => b?.start && b?.end)
        .map((b: any) => ({ startISO: String(b.start), endISO: String(b.end) }));
    }

    // fallback por si el calendar no se llama "primary"
    const firstKey = Object.keys(calendars)[0];
    const anyBusy = calendars?.[firstKey]?.busy;
    if (Array.isArray(anyBusy)) {
      return anyBusy
        .filter((b: any) => b?.start && b?.end)
        .map((b: any) => ({ startISO: String(b.start), endISO: String(b.end) }));
    }
  }

  // fallback defensivo si tu wrapper devuelve directamente fb.busy
  const busy = fb?.busy;
  if (Array.isArray(busy)) {
    return busy
      .filter((b: any) => b?.start && b?.end)
      .map((b: any) => ({ startISO: String(b.start), endISO: String(b.end) }));
  }

  return [];
}
