// src/lib/estimateFlow/runEstimateFlowTurn.ts
import { DateTime } from "luxon";
import type { Pool } from "pg";

import { isEstimateFlowEnabled } from "./isEstimateFlowEnabled";
import { getEstimateFlowState } from "./getEstimateFlowState";
import { handleEstimateFlowTurn } from "./handleEstimateFlowTurn";
import { saveEstimateRequest } from "./saveEstimateRequest";

import { getBusinessHours } from "../../lib/appointments/booking/db";
import { getSlotsForDate } from "../appointments/booking/slots";
import {
  googleCreateEvent,
  googleDeleteEvent,
} from "../../services/googleCalendar";

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

  function normalizeEstimateLang(value: unknown): Lang {
    return String(value || "").trim().toLowerCase() === "en" ? "en" : "es";
  }

  const detectedLang = normalizeEstimateLang(idiomaDestino);

  // Si el flow ya está activo, conservamos su idioma.
  // Solo sembramos idioma al iniciar o si no existe.
  if (!estimateState.lang) {
    estimateState = {
      ...estimateState,
      lang: detectedLang,
    };
  }

  const effectiveEstimateLang: Lang = normalizeEstimateLang(
    estimateState.lang || detectedLang
  );

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

      const normalizedContacto = String(contactoNorm || "").trim();
      const contactoDigits = normalizedContacto.replace(/\D/g, "");

      console.log("[estimateFlow][cancel][lookup_input]", {
        tenantId: tenant.id,
        contactoNorm,
        contactoDigits,
        canal,
      });

      const { rows: estimateRows } = await pool.query(
        `
        SELECT
          id,
          calendar_event_id,
          scheduled_start_at,
          scheduled_end_at,
          status,
          contacto,
          telefono,
          canal
        FROM estimate_requests
        WHERE tenant_id = $1
          AND calendar_event_id IS NOT NULL
          AND status = 'scheduled'
          AND (
            regexp_replace(coalesce(contacto::text, ''), '[^0-9]', '', 'g') = $2
            OR regexp_replace(coalesce(telefono::text, ''), '[^0-9]', '', 'g') = $2
          )
        ORDER BY scheduled_start_at DESC NULLS LAST, created_at DESC
        LIMIT 1
        `,
        [tenant.id, contactoDigits]
      );

      console.log("[estimateFlow][cancel][existing_lookup]", {
        tenantId: tenant.id,
        contactoNorm,
        contactoDigits,
        canal,
        found: !!estimateRows[0],
        existing: estimateRows[0]
          ? {
              id: estimateRows[0].id,
              calendar_event_id: estimateRows[0].calendar_event_id,
              contacto: estimateRows[0].contacto,
              telefono: estimateRows[0].telefono,
              canal: estimateRows[0].canal,
              status: estimateRows[0].status,
              scheduled_start_at: estimateRows[0].scheduled_start_at,
            }
          : null,
      });

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

        console.log("[estimateFlow][cancel][delete_event]", {
          tenantId: tenant.id,
          contactoNorm,
          calendarEventId,
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
          console.log("[estimateFlow][ready_to_schedule][state_check]", {
            tenantId: tenant.id,
            contactoNorm,
            estimateState,
            estimateTurnNextState: estimateTurn.nextState,
            nextEstimateState,
            action_in_estimateState: estimateState?.action || null,
            action_in_turn_next: estimateTurn.nextState?.action || null,
            action_in_nextEstimateState: nextEstimateState?.action || null,
          });

          const isReschedule = nextEstimateState.action === "reschedule";

          if (isReschedule) {
            const normalizedContacto = String(contactoNorm || "").trim();
            const contactoDigits = normalizedContacto.replace(/\D/g, "");

            console.log("[estimateFlow][reschedule][lookup_input]", {
              tenantId: tenant.id,
              contactoNorm,
              contactoDigits,
              canal,
              nextEstimateState,
              estimateState,
            });

            const { rows: existingRows } = await pool.query(
              `
              SELECT
                id,
                calendar_event_id,
                calendar_event_link,
                nombre,
                telefono,
                direccion,
                tipo_trabajo,
                preferred_date,
                preferred_time,
                scheduled_start_at,
                scheduled_end_at,
                status,
                contacto,
                canal
              FROM estimate_requests
              WHERE tenant_id = $1
                AND status = 'scheduled'
                AND calendar_event_id IS NOT NULL
                AND (
                  regexp_replace(coalesce(contacto::text, ''), '[^0-9]', '', 'g') = $2
                  OR regexp_replace(coalesce(telefono::text, ''), '[^0-9]', '', 'g') = $2
                )
              ORDER BY
                (
                  CASE WHEN nombre IS NOT NULL AND btrim(nombre) <> '' THEN 1 ELSE 0 END +
                  CASE WHEN direccion IS NOT NULL AND btrim(direccion) <> '' THEN 1 ELSE 0 END +
                  CASE WHEN tipo_trabajo IS NOT NULL AND btrim(tipo_trabajo) <> '' THEN 1 ELSE 0 END
                ) DESC,
                scheduled_start_at DESC NULLS LAST,
                created_at DESC
              LIMIT 1
              `,
              [tenant.id, contactoDigits]
            );

            console.log("[estimateFlow][reschedule][existing_lookup]", {
              tenantId: tenant.id,
              contactoNorm,
              canal,
              found: !!existingRows[0],
              existing: existingRows[0]
                ? {
                    id: existingRows[0].id,
                    calendar_event_id: existingRows[0].calendar_event_id,
                    nombre: existingRows[0].nombre,
                    telefono: existingRows[0].telefono,
                    direccion: existingRows[0].direccion,
                    tipo_trabajo: existingRows[0].tipo_trabajo,
                    contacto: existingRows[0].contacto,
                    canal: existingRows[0].canal,
                    status: existingRows[0].status,
                    scheduled_start_at: existingRows[0].scheduled_start_at,
                  }
                : null,
            });

            const existing = existingRows[0] || null;

            if (!existing?.id || !existing?.calendar_event_id) {
              finalReply =
                effectiveEstimateLang === "en"
                  ? "I couldn’t find your current appointment to reschedule. Please schedule a new one instead."
                  : "No pude encontrar tu cita actual para reagendarla. Por favor agenda una nueva.";

              nextEstimateState = {
                ...nextEstimateState,
                lang: effectiveEstimateLang,
                active: false,
                step: "idle",
                action: null,
              };
            } else {
              const resolvedName =
                String(
                  existing?.nombre ||
                    nextEstimateState?.name ||
                    estimateState?.name ||
                    ""
                ).trim() || null;

              const resolvedPhone =
                String(
                  existing?.telefono ||
                    nextEstimateState?.phone ||
                    estimateState?.phone ||
                    contactoNorm ||
                    ""
                ).trim() || null;

              const resolvedAddress =
                String(
                  existing?.direccion ||
                    nextEstimateState?.address ||
                    estimateState?.address ||
                    ""
                ).trim() || null;

              const resolvedJobType =
                String(
                  existing?.tipo_trabajo ||
                    nextEstimateState?.jobType ||
                    estimateState?.jobType ||
                    "Visita técnica"
                ).trim();

              const summary = `Estimado — ${resolvedJobType}`;

              const description = [
                "Agendado por Aamy",
                resolvedName ? `Cliente: ${resolvedName}` : "",
                resolvedPhone ? `Teléfono: ${resolvedPhone}` : "",
                resolvedAddress ? `Dirección: ${resolvedAddress}` : "",
                resolvedJobType ? `Trabajo: ${resolvedJobType}` : "",
                `Canal: ${canal}`,
                `Contacto: ${contactoNorm}`,
              ]
                .filter(Boolean)
                .join("\n");

              const oldEventId = String(existing.calendar_event_id || "").trim();

              if (oldEventId) {
                try {
                  await googleDeleteEvent({
                    tenantId: tenant.id,
                    calendarId,
                    eventId: oldEventId,
                  });

                  console.log("[estimateFlow][reschedule][delete_old_event]", {
                    tenantId: tenant.id,
                    contactoNorm,
                    oldEventId,
                    outcome: "deleted",
                  });
                } catch (e: any) {
                  const raw = JSON.stringify(e || {});
                  const msg = String(e?.message || raw || "").toLowerCase();
                  const status = Number(
                    e?.status ||
                    e?.response?.status ||
                    e?.body?.error?.code ||
                    0
                  );

                  const alreadyDeleted =
                    status === 410 ||
                    msg.includes("resource has been deleted") ||
                    msg.includes("google_delete_event_failed") ||
                    msg.includes('"code":410') ||
                    msg.includes("410");

                  if (!alreadyDeleted) {
                    throw e;
                  }

                  console.warn("[estimateFlow][reschedule] old event already deleted in Google, continuing", {
                    tenantId: tenant.id,
                    contactoNorm,
                    oldEventId,
                    status,
                  });
                }
              }

              const event = await googleCreateEvent({
                tenantId: tenant.id,
                calendarId,
                summary,
                description,
                startISO: selectedSlot.startISO,
                endISO: selectedSlot.endISO,
                timeZone,
              });

              console.log("[estimateFlow][reschedule][create_new_event]", {
                tenantId: tenant.id,
                contactoNorm,
                newEventId: String(event?.id || ""),
                newEventLink: String(event?.htmlLink || event?.meetLink || ""),
                resolvedName,
                resolvedPhone,
                resolvedAddress,
                resolvedJobType,
                selectedSlot,
              });

              await pool.query(
                `
                UPDATE estimate_requests
                SET
                  nombre = $1,
                  telefono = $2,
                  direccion = $3,
                  tipo_trabajo = $4,
                  preferred_date = $5,
                  preferred_time = $6,
                  scheduled_start_at = $7,
                  scheduled_end_at = $8,
                  calendar_event_id = $9,
                  calendar_event_link = $10,
                  status = 'scheduled'
                WHERE id = $11
                `,
                [
                  resolvedName,
                  resolvedPhone,
                  resolvedAddress,
                  resolvedJobType,
                  preferredDate,
                  selectedSlot.label || null,
                  selectedSlot.startISO,
                  selectedSlot.endISO,
                  String(event?.id || ""),
                  String(event?.htmlLink || event?.meetLink || ""),
                  existing.id,
                ]
              );

              nextEstimateState = {
                ...nextEstimateState,
                lang: effectiveEstimateLang,
                active: false,
                step: "scheduled",
                action: null,
                name: resolvedName,
                phone: resolvedPhone,
                address: resolvedAddress,
                jobType: resolvedJobType,
                calendarEventId: String(event?.id || ""),
                calendarEventLink: String(event?.htmlLink || event?.meetLink || ""),
              };

              finalReply =
                effectiveEstimateLang === "en"
                  ? [
                      "Perfect 😊 Your appointment has been rescheduled successfully.",
                      `• Date: ${preferredDate}`,
                      `• Time: ${selectedSlot.label || ""}`,
                      nextEstimateState.calendarEventLink
                        ? `• Calendar link: ${nextEstimateState.calendarEventLink}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n")
                  : [
                      "Perfecto 😊 Tu cita fue reagendada correctamente.",
                      `• Fecha: ${preferredDate}`,
                      `• Hora: ${selectedSlot.label || ""}`,
                      nextEstimateState.calendarEventLink
                        ? `• Link del calendario: ${nextEstimateState.calendarEventLink}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join("\n");
            }
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
              action: null,
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

  console.log("[estimateFlow][action_check]", {
    action_in_state: estimateState?.action || null,
    action_in_turn: estimateTurn?.nextState?.action || null,
    action_in_next: nextEstimateState?.action || null,
  });

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