// src/lib/estimateFlow/runEstimateFlowTurn.ts
import { DateTime } from "luxon";
import type { Pool } from "pg";

import { isEstimateFlowEnabled } from "./isEstimateFlowEnabled";
import { getEstimateFlowState } from "./getEstimateFlowState";
import { handleEstimateFlowTurn } from "./handleEstimateFlowTurn";
import { saveEstimateRequest } from "./saveEstimateRequest";

import { getBusinessHours } from "../../lib/appointments/booking/db";
import { getSlotsForDate } from "../appointments/booking/slots";
import { googleCreateEvent, googleDeleteEvent } from "../../services/googleCalendar";

type Lang = "es" | "en";

type RunEstimateFlowParams = {
  pool: Pool;
  tenant: {
    id: string;
    timezone?: string | null;
  };
  convoCtx: any;
  userInput: string;
  idiomaDestino: Lang;
  canal: string;
  contactoNorm: string;
};

type RunEstimateFlowResult =
  | { handled: false }
  | {
      handled: true;
      finalReply: string;
      nextEstimateState: any;
    };

export async function runEstimateFlowTurn({
  pool,
  tenant,
  convoCtx,
  userInput,
  idiomaDestino,
  canal,
  contactoNorm,
}: RunEstimateFlowParams): Promise<RunEstimateFlowResult> {
  const estimateEnabled = await isEstimateFlowEnabled(pool, tenant.id);
  if (!estimateEnabled) return { handled: false };

  let estimateState = getEstimateFlowState(convoCtx);

  if (!estimateState.lang || estimateState.lang !== idiomaDestino) {
    estimateState = {
      ...estimateState,
      lang: idiomaDestino,
    };
  }

  const effectiveEstimateLang: Lang =
    (estimateState.lang as Lang) || idiomaDestino;

  const estimateTurn = handleEstimateFlowTurn({
    userInput,
    lang: effectiveEstimateLang,
    canal,
    currentState: estimateState,
    contactoFallback: contactoNorm,
    timeZone: String(tenant?.timezone || "America/New_York"),
  });

  const nextStep = estimateTurn.nextState?.step;

  const shouldContinueEvenIfNotHandled =
    nextStep === "ready_to_cancel" ||
    nextStep === "offering_slots" ||
    nextStep === "ready_to_schedule";

  if (!estimateTurn.handled && !shouldContinueEvenIfNotHandled) {
    return { handled: false };
  }

  let nextEstimateState = {
    ...estimateState,
    ...(estimateTurn.nextState || {}),
    lang:
      ((estimateTurn.nextState as any)?.lang as Lang) || effectiveEstimateLang,
  };

  let finalReply = estimateTurn.handled ? estimateTurn.reply : "";

  // =========================================================
  // ready_to_cancel
  // =========================================================
  if (nextStep === "ready_to_cancel") {
    try {
      const { rows: calendarRows } = await pool.query(
        `
        SELECT calendar_id
        FROM calendar_integrations
        WHERE tenant_id = $1
          AND provider = 'google'
          AND status = 'connected'
        LIMIT 1
        `,
        [tenant.id]
      );

      const calendarId = calendarRows[0]?.calendar_id || "primary";

      const { rows: estimateRows } = await pool.query(
        `
        SELECT
          id,
          calendar_event_id,
          scheduled_start_at,
          scheduled_end_at,
          status
        FROM estimate_requests
        WHERE tenant_id = $1
          AND contacto = $2
          AND canal = $3
          AND calendar_event_id IS NOT NULL
          AND status = 'scheduled'
        ORDER BY scheduled_start_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        `,
        [tenant.id, contactoNorm, canal]
      );

      const row = estimateRows[0];
      const calendarEventId = String(row?.calendar_event_id || "").trim();

      if (!calendarEventId) {
        finalReply =
          effectiveEstimateLang === "en"
            ? "I couldn’t find a scheduled appointment to cancel."
            : "No pude encontrar una cita agendada para cancelar.";

        nextEstimateState = {
          ...nextEstimateState,
          lang: effectiveEstimateLang,
          active: false,
          step: "cancelled",
          action: null,
          calendarEventId: null,
          calendarEventLink: null,
        };

        return {
          handled: true,
          finalReply,
          nextEstimateState,
        };
      }

      try {
        await googleDeleteEvent({
          tenantId: tenant.id,
          calendarId,
          eventId: calendarEventId,
        });
      } catch (e: any) {
        const msg = String(e?.message || "").toLowerCase();
        const status = Number(e?.status || e?.response?.status || 0);

        const alreadyDeleted =
          status === 410 ||
          msg.includes("resource has been deleted") ||
          msg.includes("410");

        if (!alreadyDeleted) {
          throw e;
        }

        console.warn("[estimateFlow] cancel already deleted in Google Calendar", {
          tenantId: tenant.id,
          contactoNorm,
          calendarEventId,
        });
      }

      await pool.query(
        `
        UPDATE estimate_requests
        SET status = 'cancelled'
        WHERE id = $1
        `,
        [row.id]
      );

      nextEstimateState = {
        ...nextEstimateState,
        lang: effectiveEstimateLang,
        active: false,
        step: "cancelled",
        action: null,
        calendarEventId: null,
        calendarEventLink: null,
      };

      finalReply =
        effectiveEstimateLang === "en"
          ? "Perfect 😊 Your appointment has been canceled successfully."
          : "Perfecto 😊 Tu cita fue cancelada correctamente.";
    } catch (e: any) {
      console.warn("[estimateFlow] cancel error:", e?.message);

      finalReply =
        effectiveEstimateLang === "en"
          ? "I couldn’t cancel the appointment right now. Please try again in a moment."
          : "No pude cancelar la cita en este momento. Por favor inténtalo nuevamente en un momento.";

      nextEstimateState = {
        ...nextEstimateState,
        lang: effectiveEstimateLang,
        active: true,
        step: "ready_to_cancel",
      };
    }

    console.log("[estimateFlow][before_transition]", {
      currentStep: estimateState.step,
      nextStep: nextEstimateState.step,
      offeredSlots: (nextEstimateState as any).offeredSlots,
      offeredSlotsLen: Array.isArray((nextEstimateState as any).offeredSlots)
        ? (nextEstimateState as any).offeredSlots.length
        : null,
      selectedSlot: (nextEstimateState as any).selectedSlot || null,
    });

    return {
      handled: true,
      finalReply,
      nextEstimateState,
    };
  }

  // =========================================================
  // offering_slots
  // =========================================================
  if (nextStep === "offering_slots") {
    try {
      const preferredDate = String(
        estimateTurn.nextState?.preferredDate || ""
      ).trim();

      const timeZone = String(tenant?.timezone || "America/New_York");

      const hours = await getBusinessHours(tenant.id);

      const { rows: calendarRows } = await pool.query(
        `
        SELECT calendar_id
        FROM calendar_integrations
        WHERE tenant_id = $1
          AND provider = 'google'
          AND status = 'connected'
        LIMIT 1
        `,
        [tenant.id]
      );

      const calendarId = calendarRows[0]?.calendar_id || "primary";

      const slots = await getSlotsForDate({
        tenantId: tenant.id,
        timeZone,
        dateISO: preferredDate,
        durationMin: 60,
        bufferMin: 0,
        hours,
        minLeadMinutes: 0,
        calendarId,
      });

      if (!slots.length) {
        finalReply =
          effectiveEstimateLang === "en"
            ? "I don’t have available times for that date. Please send me another date in YYYY-MM-DD format."
            : "No tengo horarios disponibles para esa fecha. Por favor envíame otra fecha en formato YYYY-MM-DD.";

        nextEstimateState = {
          ...nextEstimateState,
          lang: effectiveEstimateLang,
          offeredSlots: [],
          selectedSlot: null,
          step: "awaiting_date",
        };
      } else {
        const limitedSlots = slots.slice(0, 3).map((slot) => {
          const dt = DateTime.fromISO(slot.startISO, { zone: timeZone });

          const label =
            effectiveEstimateLang === "en"
              ? dt.toFormat("h:mm a")
              : dt.setLocale("es").toFormat("h:mm a");

          return {
            startISO: slot.startISO,
            endISO: slot.endISO,
            label,
          };
        });

        finalReply =
          effectiveEstimateLang === "en"
            ? [
                `These are the available times I have for ${preferredDate}:`,
                ...limitedSlots.map((s, i) => `${i + 1}. ${s.label}`),
                "",
                "Reply with the number of the time that works best for you.",
              ].join("\n")
            : [
                `Estos son los horarios disponibles que tengo para ${preferredDate}:`,
                ...limitedSlots.map((s, i) => `${i + 1}. ${s.label}`),
                "",
                "Respóndeme con el número del horario que te funciona mejor.",
              ].join("\n");

        nextEstimateState = {
          ...nextEstimateState,
          lang: effectiveEstimateLang,
          offeredSlots: limitedSlots,
          selectedSlot: null,
          step: "awaiting_slot_choice",
        };
      }
    } catch (e: any) {
      console.warn("[estimateFlow] offering_slots error:", e?.message);

      finalReply =
        effectiveEstimateLang === "en"
          ? "I couldn’t check available times right now. Please send me another date later."
          : "No pude consultar los horarios disponibles en este momento. Por favor inténtalo con otra fecha más tarde.";

      nextEstimateState = {
        ...nextEstimateState,
        lang: effectiveEstimateLang,
        offeredSlots: [],
        selectedSlot: null,
        step: "awaiting_date",
      };
    }
  }

  // =========================================================
  // ready_to_schedule
  // =========================================================
  if (nextStep === "ready_to_schedule") {
    try {
      const preferredDate = String(
        estimateTurn.nextState?.preferredDate || ""
      ).trim();

      const selectedSlot = (estimateTurn.nextState as any)?.selectedSlot || null;

      if (!selectedSlot?.startISO || !selectedSlot?.endISO) {
        finalReply =
          effectiveEstimateLang === "en"
            ? "I couldn’t identify the selected time. Please choose one of the available options again."
            : "No pude identificar el horario seleccionado. Por favor elige nuevamente una de las opciones disponibles.";

        nextEstimateState = {
          ...nextEstimateState,
          lang: effectiveEstimateLang,
          step: "awaiting_slot_choice",
        };
      } else {
        const timeZone = String(tenant?.timezone || "America/New_York");

        const { rows: calendarRows } = await pool.query(
          `
          SELECT calendar_id
          FROM calendar_integrations
          WHERE tenant_id = $1
            AND provider = 'google'
            AND status = 'connected'
          LIMIT 1
          `,
          [tenant.id]
        );

        const calendarId = calendarRows[0]?.calendar_id || "primary";

        const { validateSlotStillFree } = await import(
          "../appointments/booking/slots"
        );

        const stillFree = await validateSlotStillFree({
          tenantId: tenant.id,
          calendarId,
          slot: {
            startISO: selectedSlot.startISO,
            endISO: selectedSlot.endISO,
          },
        });

        if (!stillFree) {
          finalReply =
            effectiveEstimateLang === "en"
              ? "That time is no longer available. Please choose another available time."
              : "Ese horario ya no está disponible. Por favor elige otro horario disponible.";

          nextEstimateState = {
            ...nextEstimateState,
            lang: effectiveEstimateLang,
            selectedSlot: null,
            step: "offering_slots",
          };
        } else {
          const summary = `Estimado — ${
            estimateTurn.nextState?.jobType || "Visita técnica"
          }`;

          const description = [
            "Agendado por Aamy",
            `Cliente: ${estimateTurn.nextState?.name || ""}`,
            `Teléfono: ${estimateTurn.nextState?.phone || ""}`,
            `Dirección: ${estimateTurn.nextState?.address || ""}`,
            `Trabajo: ${estimateTurn.nextState?.jobType || ""}`,
            `Canal: ${canal}`,
            `Contacto: ${contactoNorm}`,
          ]
            .filter(Boolean)
            .join("\n");

          const event = await googleCreateEvent({
            tenantId: tenant.id,
            calendarId,
            summary,
            description,
            startISO: selectedSlot.startISO,
            endISO: selectedSlot.endISO,
            timeZone,
          });

          nextEstimateState = {
            ...nextEstimateState,
            lang: effectiveEstimateLang,
            active: false,
            step: "scheduled",
            calendarEventId: String(event?.id || ""),
            calendarEventLink: String(event?.htmlLink || event?.meetLink || ""),
          };

          finalReply =
            effectiveEstimateLang === "en"
              ? [
                  "Perfect 😊 Your appointment has been scheduled successfully.",
                  `• Date: ${preferredDate}`,
                  `• Time: ${selectedSlot.label || ""}`,
                  event?.htmlLink ? `• Calendar link: ${event.htmlLink}` : "",
                ]
                  .filter(Boolean)
                  .join("\n")
              : [
                  "Perfecto 😊 Tu cita quedó agendada correctamente.",
                  `• Fecha: ${preferredDate}`,
                  `• Hora: ${selectedSlot.label || ""}`,
                  event?.htmlLink ? `• Link del calendario: ${event.htmlLink}` : "",
                ]
                  .filter(Boolean)
                  .join("\n");
        }

        try {
          const saved = await saveEstimateRequest({
            pool,
            tenantId: tenant.id,
            canal,
            contacto: contactoNorm,
            state: nextEstimateState,
          });

          console.log("[estimateFlow] saveEstimateRequest =", {
            tenantId: tenant.id,
            contacto: contactoNorm,
            ok: saved?.ok || false,
            reason: (saved as any)?.reason || null,
          });
        } catch (e: any) {
          console.warn("[estimateFlow] saveEstimateRequest error:", e?.message);
        }
      }
    } catch (e: any) {
      console.warn("[estimateFlow] calendar scheduling error:", e?.message);

      finalReply =
        effectiveEstimateLang === "en"
          ? "I couldn’t schedule the estimate automatically right now. I already saved your information and the team can follow up with you."
          : "No pude agendar el estimado automáticamente en este momento. Ya guardé tu información y el equipo puede continuar contigo.";

      try {
        const saved = await saveEstimateRequest({
          pool,
          tenantId: tenant.id,
          canal,
          contacto: contactoNorm,
          state: nextEstimateState,
        });

        console.log("[estimateFlow] saveEstimateRequest fallback =", {
          tenantId: tenant.id,
          contacto: contactoNorm,
          ok: saved?.ok || false,
          reason: (saved as any)?.reason || null,
        });
      } catch (e2: any) {
        console.warn("[estimateFlow] saveEstimateRequest fallback error:", e2?.message);
      }

      nextEstimateState = {
        ...nextEstimateState,
        lang: effectiveEstimateLang,
        active: false,
        step: "scheduled",
      };
    }
  }

  console.log("[estimateFlow][before_transition]", {
    currentStep: estimateState.step,
    nextStep: nextEstimateState.step,
    offeredSlots: (nextEstimateState as any).offeredSlots,
    offeredSlotsLen: Array.isArray((nextEstimateState as any).offeredSlots)
      ? (nextEstimateState as any).offeredSlots.length
      : null,
    selectedSlot: (nextEstimateState as any).selectedSlot || null,
  });

  return {
    handled: true,
    finalReply,
    nextEstimateState,
  };
}