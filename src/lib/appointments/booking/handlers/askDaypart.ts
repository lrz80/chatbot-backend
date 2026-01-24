// src/lib/appointments/booking/handlers/askDaypart.ts
import { DateTime } from "luxon";

import {
  wantsToCancel,
  wantsToChangeTopic,
  detectDaypart,
  buildAskAllMessage,
} from "../text";

import { renderSlotsMessage } from "../time";
import { getNextSlotsByDaypart } from "../slots";

export type AskDaypartDeps = {
  tenantId: string;
  idioma: "es" | "en";
  userText: string;

  booking: any; // BookingCtx.booking
  timeZone: string;
  durationMin: number;
  bufferMin: number;
  hours: any | null; // HoursByWeekday | null
};

export async function handleAskDaypart(deps: AskDaypartDeps): Promise<{
  handled: boolean;
  reply?: string;
  ctxPatch?: any;
}> {
  const {
    tenantId,
    idioma,
    userText,
    booking,
    timeZone,
    durationMin,
    bufferMin,
    hours,
  } = deps;

  if (wantsToChangeTopic(userText)) {
    return { handled: false, ctxPatch: { booking: { step: "idle" } } };
  }

  if (wantsToCancel(userText)) {
    return {
      handled: true,
      reply:
        idioma === "en"
          ? "No worries, whenever you’re ready to schedule, I’ll be here to help."
          : "No hay problema, cuando necesites agendar estaré aquí para ayudarte.",
      ctxPatch: {
        booking: { step: "idle" },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const dp = detectDaypart(userText);
  if (!dp) {
    return {
      handled: true,
      reply: idioma === "en" ? "Please reply: morning or afternoon." : "Respóndeme: mañana o tarde.",
      ctxPatch: {
        booking: { ...booking, step: "ask_daypart", timeZone },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  // Si no hay horario configurado: pasamos a ask_all (captura manual)
  if (!hours) {
    return {
      handled: true,
      reply: buildAskAllMessage(idioma, booking?.purpose || null),
      ctxPatch: {
        booking: {
          ...booking,
          step: "ask_all",
          timeZone,
          daypart: dp,
        },
        booking_last_touch_at: Date.now(),
      },
    };
  }

  const slots = await getNextSlotsByDaypart({
    tenantId,
    timeZone,
    durationMin,
    bufferMin,
    hours,
    daypart: dp,
    daysAhead: 7,
  });

  const dateOnlyFromFirst = slots?.[0]?.startISO
    ? DateTime.fromISO(slots[0].startISO, { zone: timeZone }).toFormat("yyyy-MM-dd")
    : null;

  return {
    handled: true,
    reply: renderSlotsMessage({ idioma, timeZone, slots }),
    ctxPatch: {
      booking: {
        step: "offer_slots",
        timeZone,
        purpose: booking?.purpose || null,
        daypart: dp,
        slots,
        date_only: null,
        last_offered_date: dateOnlyFromFirst,
      },
      booking_last_touch_at: Date.now(),
    },
  };
}
