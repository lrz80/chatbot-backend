// src/lib/estimateFlow/runEstimateFlowTurn.ts
import { DateTime } from "luxon";
import type { Pool } from "pg";

import { isEstimateFlowEnabled } from "./isEstimateFlowEnabled";
import { getEstimateFlowState } from "./getEstimateFlowState";
import { handleEstimateFlowTurn } from "./handleEstimateFlowTurn";
import { saveEstimateRequest } from "./saveEstimateRequest";

import { getBusinessHours } from "../../lib/appointments/booking/db";
import { getSlotsForDate } from "../appointments/booking/slots";
import { googleCreateEvent } from "../../services/googleCalendar";

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

  if (!estimateTurn.handled) {
    return { handled: false };
  }

  let nextEstimateState = {
    ...estimateState,
    ...estimateTurn.nextState,
    lang:
      (estimateTurn.nextState.lang as Lang) || effectiveEstimateLang,
  };

  let finalReply = estimateTurn.reply;

  // =========================================================
  // offering_slots
  // =========================================================
  if (estimateTurn.nextState.step === "offering_slots") {
    try {
      const preferredDate = String(
        estimateTurn.nextState.preferredDate || ""
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
          ...estimateTurn.nextState,
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
          ...estimateTurn.nextState,
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
        ...estimateTurn.nextState,
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
  if (estimateTurn.nextState.step === "ready_to_schedule") {
    try {
      const preferredDate = String(
        estimateTurn.nextState.preferredDate || ""
      ).trim();

      const selectedSlot = (estimateTurn.nextState as any)?.selectedSlot || null;

      if (!selectedSlot?.startISO || !selectedSlot?.endISO) {
        finalReply =
          effectiveEstimateLang === "en"
            ? "I couldn’t identify the selected time. Please choose one of the available options again."
            : "No pude identificar el horario seleccionado. Por favor elige nuevamente una de las opciones disponibles.";

        nextEstimateState = {
          ...estimateTurn.nextState,
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
            ...estimateTurn.nextState,
            lang: effectiveEstimateLang,
            selectedSlot: null,
            step: "offering_slots",
          };
        } else {
          const summary = `Estimado — ${
            estimateTurn.nextState.jobType || "Visita técnica"
          }`;

          const description = [
            "Agendado por Aamy",
            `Cliente: ${estimateTurn.nextState.name || ""}`,
            `Teléfono: ${estimateTurn.nextState.phone || ""}`,
            `Dirección: ${estimateTurn.nextState.address || ""}`,
            `Trabajo: ${estimateTurn.nextState.jobType || ""}`,
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
            ...estimateTurn.nextState,
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
          state: estimateTurn.nextState,
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
        ...estimateTurn.nextState,
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