//src/lib/appointments/booking/providers/googleCalendarProvider.ts
import { googleCreateEvent, googleFreeBusy } from "../../../../services/googleCalendar";
import { extractBusyBlocks } from "../freebusy";
import type {
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

export class GoogleCalendarProvider implements BookingProviderAdapter {
  readonly provider = "google_calendar" as const;

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    const timeMin = new Date(
      new Date(input.startISO).getTime() - input.bufferMin * 60 * 1000
    ).toISOString();

    const timeMax = new Date(
      new Date(input.endISO).getTime() + input.bufferMin * 60 * 1000
    ).toISOString();

    const fb = await googleFreeBusy({
      tenantId: input.tenantId,
      timeMin,
      timeMax,
      calendarIds: input.calendarId ? [input.calendarId, "primary"] : ["primary"],
    });

    if ((fb as any)?.degraded) {
      return {
        ok: false,
        provider: this.provider,
        error: "FREEBUSY_DEGRADED",
        busy: [],
      };
    }

    const busy = extractBusyBlocks(fb);

    if (busy.length > 0) {
      return {
        ok: false,
        provider: this.provider,
        error: "SLOT_BUSY",
        busy,
      };
    }

    const event = await googleCreateEvent({
      tenantId: input.tenantId,
      calendarId: input.calendarId ?? undefined,
      summary: input.summary,
      description: input.description || "",
      startISO: input.startISO,
      endISO: input.endISO,
      timeZone: input.timeZone,
    });

    if (!event?.id) {
      return {
        ok: false,
        provider: this.provider,
        error: "CREATE_EVENT_FAILED",
        busy: [],
      };
    }

    return {
      ok: true,
      provider: this.provider,
      event_id: event.id,
      htmlLink: event.htmlLink ?? null,
      meetLink: (event as any)?.meetLink || (event as any)?.hangoutLink || null,
    };
  }
}