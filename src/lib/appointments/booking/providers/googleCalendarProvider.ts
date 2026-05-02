//src/lib/appointments/booking/providers/googleCalendarProvider.ts
import {
  googleCreateEvent,
  googleFreeBusy,
} from "../../../../services/googleCalendar";
import {
  extractBusyBlocks,
  isRangeFree,
  findNearestAvailableStarts,
} from "../freebusy";
import {
  getEffectiveServiceBookingRule,
  countConfirmedAppointmentsForSlot,
} from "../../serviceBookingRules";
import { getBusinessHoursFallback } from "../../getBusinessHoursFallback";
import type {
  BookingProviderAdapter,
  CreateExternalBookingInput,
  CreateExternalBookingResult,
} from "./types";

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function getWeekdayInTimeZone(date: Date, timeZone: string): number {
  const weekdayShort = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);

  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return map[weekdayShort];
}

function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  return {
    year: Number(parts.find((p) => p.type === "year")?.value || "0"),
    month: Number(parts.find((p) => p.type === "month")?.value || "0"),
    day: Number(parts.find((p) => p.type === "day")?.value || "0"),
  };
}

function buildDateTimeInTimeZone(params: {
  baseDate: Date;
  hhmm: string;
  timeZone: string;
}): Date | null {
  const { baseDate, hhmm, timeZone } = params;

  const [hourRaw, minuteRaw] = String(hhmm || "").split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const { year, month, day } = getDatePartsInTimeZone(baseDate, timeZone);

  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = formatter.formatToParts(utcGuess);

  const tzYear = Number(parts.find((p) => p.type === "year")?.value || "0");
  const tzMonth = Number(parts.find((p) => p.type === "month")?.value || "0");
  const tzDay = Number(parts.find((p) => p.type === "day")?.value || "0");
  const tzHour = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const tzMinute = Number(parts.find((p) => p.type === "minute")?.value || "0");

  const desiredUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const observedUtcMs = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 0, 0);

  return new Date(utcGuess.getTime() + (desiredUtcMs - observedUtcMs));
}

export class GoogleCalendarProvider implements BookingProviderAdapter {
  readonly provider = "google_calendar" as const;

  async createExternalBooking(
    input: CreateExternalBookingInput
  ): Promise<CreateExternalBookingResult> {
    const effectiveRule = await getEffectiveServiceBookingRule({
      tenantId: input.tenantId,
      serviceName: input.summary,
    });

    const requestedStart = new Date(input.startISO);
    const requestedEnd = new Date(input.endISO);
    const timeZone = input.timeZone || "America/New_York";

    const timeMin = addMinutes(requestedStart, -input.bufferMin).toISOString();
    const timeMax = addMinutes(requestedEnd, input.bufferMin).toISOString();

    // ✅ Servicios exclusivos: validar con freeBusy y sugerir cercanas si está ocupado
    if (effectiveRule.booking_mode === "exclusive") {
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

      const busy = extractBusyBlocks(fb, input.calendarId ?? undefined);

      const requestedIsFree = isRangeFree({
        start: requestedStart,
        durationMin: effectiveRule.duration_min,
        busyBlocks: busy,
        bufferMin: input.bufferMin,
      });

      if (!requestedIsFree) {
        const dayOfWeek = getWeekdayInTimeZone(requestedStart, timeZone);

        const businessRange = await getBusinessHoursFallback({
          tenantId: input.tenantId,
          dayOfWeek,
        });

        let suggestedStarts: string[] = [];

        if (businessRange.start && businessRange.end) {
          const businessOpenAt = buildDateTimeInTimeZone({
            baseDate: requestedStart,
            hhmm: businessRange.start,
            timeZone,
          });

          const businessCloseAt = buildDateTimeInTimeZone({
            baseDate: requestedStart,
            hhmm: businessRange.end,
            timeZone,
          });

          if (businessOpenAt && businessCloseAt) {
            const nearest = findNearestAvailableStarts({
              requestedAt: requestedStart,
              busyBlocks: busy,
              businessOpenAt,
              businessCloseAt,
              durationMin: effectiveRule.duration_min,
              bufferMin: input.bufferMin,
              stepMin: 15,
              maxSuggestions: 3,
            });

            suggestedStarts = nearest.map((d) => d.toISOString());
          }
        }

        return {
          ok: false,
          provider: this.provider,
          error: "SLOT_BUSY",
          busy,
          suggestedStarts,
        };
      }
    }

    // ✅ Servicios compartidos: validar por capacidad en DB
    if (effectiveRule.booking_mode === "shared") {
      const confirmedCount = await countConfirmedAppointmentsForSlot({
        tenantId: input.tenantId,
        serviceName: input.summary,
        startISO: input.startISO,
      });

      if (confirmedCount >= effectiveRule.slot_capacity) {
        return {
          ok: false,
          provider: this.provider,
          error: "SLOT_BUSY",
          busy: [
            {
              start: input.startISO,
              end: input.endISO,
            },
          ],
        };
      }
    }

    const event = await googleCreateEvent({
      tenantId: input.tenantId,
      calendarId: input.calendarId ?? undefined,
      summary: input.summary,
      description: input.description || "",
      startISO: input.startISO,
      endISO: input.endISO,
      timeZone,
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