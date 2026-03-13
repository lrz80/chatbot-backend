// backend/src/lib/estimateFlow/handleEstimateFlowTurn.ts

import type { Lang } from "../channels/engine/clients/clientDb";
import type { EstimateFlowState } from "./types";
import { createEmptyEstimateFlowState } from "./types";
import { updateEstimateFlowState } from "./updateEstimateFlowState";
import { DateTime } from "luxon";

type HandleEstimateFlowTurnArgs = {
  userInput: string;
  lang: Lang;
  canal?: string | null;
  currentState?: EstimateFlowState | null;
  contactoFallback?: string | null;
  timeZone?: string | null;
};

type HandleEstimateFlowTurnResult =
  | {
      handled: true;
      reply: string;
      nextState: EstimateFlowState;
    }
  | {
      handled: false;
      nextState?: EstimateFlowState;
    };

function cleanText(s: string) {
  return String(s || "").trim();
}

function isLikelyPhone(text: string) {
  const digits = text.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15;
}

function normalizePhone(text: string) {
  const raw = cleanText(text);
  const digits = raw.replace(/[^\d+]/g, "");
  return digits || raw;
}

function looksLikeStartEstimateIntent(text: string) {
  const t = cleanText(text).toLowerCase();

  return (
    /\bestimado\b/.test(t) ||
    /\bestimate\b/.test(t) ||
    /\bquote\b/.test(t) ||
    /\bcotizacion\b/.test(t) ||
    /\bcotización\b/.test(t) ||
    /\bvisita\b/.test(t) ||
    /\bagendar estimado\b/.test(t) ||
    /\bschedule estimate\b/.test(t) ||
    /\bfree estimate\b/.test(t) ||
    /\bon site estimate\b/.test(t) ||

    /\bquiero agendar\b/.test(t) ||
    /\bquiero reservar\b/.test(t) ||
    /\bagendar\b/.test(t) ||
    /\breservar\b/.test(t) ||
    /\bschedule\b/.test(t) ||
    /\bbook\b/.test(t)
  );
}

function wantsCancelEstimate(text: string) {
  const t = cleanText(text).toLowerCase();

  return (
    /\bcancelar\b/.test(t) ||
    /\bcancela\b/.test(t) ||
    /\bcancel\b/.test(t) ||
    /\bcancel my estimate\b/.test(t) ||
    /\bcancel my appointment\b/.test(t) ||
    /\bquitar la cita\b/.test(t) ||
    /\bdelete appointment\b/.test(t)
  );
}

function wantsRescheduleEstimate(text: string) {
  const t = cleanText(text).toLowerCase();

  return (
    /\breagendar\b/.test(t) ||
    /\breprogramar\b/.test(t) ||
    /\bcambiar cita\b/.test(t) ||
    /\bcambiar la cita\b/.test(t) ||
    /\bcambiar mi cita\b/.test(t) ||
    /\bcambiar una cita\b/.test(t) ||
    /\bcambiar el horario\b/.test(t) ||
    /\bquiero cambiar mi cita\b/.test(t) ||
    /\bquiero reagendar\b/.test(t) ||
    /\bquiero reprogramar\b/.test(t) ||
    /\bchange appointment\b/.test(t) ||
    /\breschedule\b/.test(t) ||
    /\bmove the appointment\b/.test(t)
  );
}

function wantsExitFlow(text: string) {
  const t = cleanText(text).toLowerCase();

  return (
    /^gracias[.!]*$/.test(t) ||
    /^muchas gracias[.!]*$/.test(t) ||
    /^ok[.!]*$/.test(t) ||
    /^okay[.!]*$/.test(t) ||
    /^dale[.!]*$/.test(t) ||
    /^perfecto[.!]*$/.test(t) ||
    /^perfect[.!]*$/.test(t) ||
    /^no gracias[.!]*$/.test(t) ||
    /^no, gracias[.!]*$/.test(t) ||
    /^ya no[.!]*$/.test(t) ||
    /^olvidalo[.!]*$/.test(t) ||
    /^olvídalo[.!]*$/.test(t) ||
    /^never mind[.!]*$/.test(t) ||
    /^cancela eso[.!]*$/.test(t) ||
    /^déjalo así[.!]*$/.test(t) ||
    /^dejalo asi[.!]*$/.test(t)
  );
}

function wantsManageExistingEstimate(text: string) {
  const t = cleanText(text).toLowerCase();

  return (
    /\bcita\b/.test(t) ||
    /\bappointment\b/.test(t) ||
    /\breserva\b/.test(t) ||
    /\bbooking\b/.test(t)
  );
}

function parseFlexibleDateInput(
  text: string,
  lang: Lang,
  timeZone: string
): string | null {
  const raw = cleanText(text);
  if (!raw) return null;

  const now = DateTime.now().setZone(timeZone).startOf("day");
  const lower = raw.toLowerCase();

  if (/\bhoy\b/.test(lower) || /\btoday\b/.test(lower)) {
    return now.toFormat("yyyy-MM-dd");
  }

  if (
    /\bmañana\b/.test(lower) ||
    /\bmanana\b/.test(lower) ||
    /\btomorrow\b/.test(lower)
  ) {
    return now.plus({ days: 1 }).toFormat("yyyy-MM-dd");
  }

  const formats = [
    "yyyy-MM-dd",
    "M/d/yyyy",
    "M/d/yy",
    "MM/dd/yyyy",
    "MM/dd/yy",
    "d/M/yyyy",
    "d/M/yy",
    "dd/MM/yyyy",
    "dd/MM/yy",
    "MMMM d yyyy",
    "MMMM d, yyyy",
    "MMM d yyyy",
    "MMM d, yyyy",
    "d MMMM yyyy",
    "d MMM yyyy",
    "MMMM d",
    "MMM d",
    "d MMMM",
    "d MMM",
  ];

  for (const fmt of formats) {
    const dt = DateTime.fromFormat(raw, fmt, {
      zone: timeZone,
      locale: lang === "es" ? "es" : "en",
    });

    if (dt.isValid) {
      const normalized = /\b\d{4}\b/.test(raw)
        ? dt
        : dt.set({ year: now.year });

      return normalized.toFormat("yyyy-MM-dd");
    }
  }

  const iso = DateTime.fromISO(raw, { zone: timeZone });
  if (iso.isValid) {
    return iso.toFormat("yyyy-MM-dd");
  }

  const jsDate = DateTime.fromJSDate(new Date(raw), { zone: timeZone });
  if (jsDate.isValid) {
    return jsDate.toFormat("yyyy-MM-dd");
  }

  return null;
}

function isValidDateInput(text: string, lang: Lang, timeZone: string) {
  return !!parseFlexibleDateInput(text, lang, timeZone);
}

function isValidTimeInput(text: string) {
  const t = cleanText(text).toUpperCase();
  return /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/.test(t);
}

function askName(lang: Lang) {
  return lang === "en"
    ? "Sure 😊 To schedule, first tell me your full name."
    : "Claro 😊 Para agendar, primero dime tu nombre completo.";
}

function askPhone(lang: Lang, name?: string | null) {
  return lang === "en"
    ? `${name ? `Perfect, ${name}. ` : ""}What is your best phone number?`
    : `${name ? `Perfecto, ${name}. ` : ""}¿Cuál es tu mejor número de teléfono?`;
}

function askAddress(lang: Lang) {
  return lang === "en"
    ? "Thanks. What is the address?"
    : "Gracias. ¿Cuál es la dirección?";
}

function askJobType(lang: Lang) {
  return lang === "en"
    ? "Got it. What type of service do you need exactly?"
    : "Entendido. ¿Qué tipo de servicio necesitas exactamente?";
}

function askDate(lang: Lang) {
  return lang === "en"
    ? "Perfect. What date works best? Please send it in YYYY-MM-DD format."
    : "Perfecto. ¿Qué fecha te funciona mejor? Envíamela en formato YYYY-MM-DD.";
}

function askSlotChoice(lang: Lang) {
  return lang === "en"
    ? "Please reply with the number of the time that works best for you."
    : "Por favor respóndeme con el número del horario que te funciona mejor.";
}

function readyMessage(args: {
  lang: Lang;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  jobType?: string | null;
  preferredDate?: string | null;
  preferredTime?: string | null;
}) {
  const { lang, name, phone, address, jobType, preferredDate, preferredTime } = args;

  if (lang === "en") {
    return [
      "Perfect 😊 I already have the information:",
      name ? `• Name: ${name}` : "",
      phone ? `• Phone: ${phone}` : "",
      address ? `• Address: ${address}` : "",
      jobType ? `• Work type: ${jobType}` : "",
      preferredDate ? `• Date: ${preferredDate}` : "",
      preferredTime ? `• Time: ${preferredTime}` : "",
      "",
      "Now I’m going to try to schedule automatically.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "Perfecto 😊 Ya tengo la información:",
    name ? `• Nombre: ${name}` : "",
    phone ? `• Teléfono: ${phone}` : "",
    address ? `• Dirección: ${address}` : "",
    jobType ? `• Tipo de trabajo: ${jobType}` : "",
    preferredDate ? `• Fecha: ${preferredDate}` : "",
    preferredTime ? `• Hora: ${preferredTime}` : "",
    "",
    "Ahora voy a intentar agendar automáticamente.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function handleEstimateFlowTurn(
  args: HandleEstimateFlowTurnArgs
): HandleEstimateFlowTurnResult {
  const { userInput, lang, canal, currentState, contactoFallback, timeZone } = args;
  const effectiveTimeZone = String(timeZone || "America/New_York");

  const text = cleanText(userInput);
  const state = currentState?.active
    ? currentState
    : createEmptyEstimateFlowState();

  // ✅ IMPORTANTE:
  // no limpiar el flujo si ya está listo para ejecutar una acción real
  const isExecutionStep =
    state.step === "ready_to_cancel" ||
    state.step === "ready_to_schedule";

  if (state.active && !isExecutionStep && wantsExitFlow(text)) {
    return {
      handled: true,
      reply:
        lang === "en"
          ? "No problem 😊 If you want to schedule later, just write: I want to schedule."
          : "No hay problema 😊 Si luego quieres agendar, solo escribe: Quiero agendar.",
      nextState: createEmptyEstimateFlowState(),
    };
  }

  // =========================
  // 1) ARRANQUE DEL FLUJO
  // =========================
  if (!state.active) {
    const normalizedPhone = state.phone || (contactoFallback ? normalizePhone(contactoFallback) : null);

    // ✅ si pide reagendar / mover / cambiar, ir directo a reagendar
    if (wantsRescheduleEstimate(text)) {
      const nextState = updateEstimateFlowState(state, {
        active: true,
        action: "reschedule",
        step: "awaiting_date",
        phone: normalizedPhone,
      });

      return {
        handled: true,
        reply:
          lang === "en"
            ? "Sure 😊 Tell me the new date you want for your appointment."
            : "Claro 😊 Dime qué nueva fecha te gustaría para tu cita.",
        nextState,
      };
    }

    // ✅ si pide cancelar, NO cancelar directo; ofrecer cancelar o reagendar
    if (wantsCancelEstimate(text)) {
      const nextState = updateEstimateFlowState(state, {
        active: true,
        step: "manage_existing",
        phone: normalizedPhone,
        action: null,
      });

      return {
        handled: true,
        reply:
          lang === "en"
            ? "I can help with that 😊\n\nWhat would you like to do?\n1. Cancel your appointment\n2. Reschedule your appointment\n\nPlease reply with the number of the option you prefer."
            : "Puedo ayudarte con eso 😊\n\n¿Qué deseas hacer?\n1. Cancelar tu cita\n2. Reagendar tu cita\n\nRespóndeme con el número de la opción que prefieres.",
        nextState,
      };
    }

    if (wantsManageExistingEstimate(text)) {
      const nextState = updateEstimateFlowState(state, {
        active: true,
        step: "manage_existing",
        phone: normalizedPhone,
        action: null,
      });

      return {
        handled: true,
        reply:
          lang === "en"
            ? "I can help with that 😊\n\nWhat would you like to do?\n1. Cancel your appointment\n2. Reschedule your appointment\n\nPlease reply with the number of the option you prefer."
            : "Puedo ayudarte con eso 😊\n\n¿Qué deseas hacer?\n1. Cancelar tu cita\n2. Reagendar tu cita\n\nRespóndeme con el número de la opción que prefieres.",
        nextState,
      };
    }

    if (!looksLikeStartEstimateIntent(text)) {
      return { handled: false };
    }

    const nextState = updateEstimateFlowState(state, {
      active: true,
      step: "awaiting_name",
      phone: normalizedPhone,
    });

    return {
      handled: true,
      reply: askName(lang),
      nextState,
    };
  }

  // =========================
  // MANEJO DE CITA EXISTENTE
  // =========================
  if (state.step === "manage_existing") {
    const choice = cleanText(text).toLowerCase();

    const wantsCancelChoice =
      choice === "1" ||
      /\bcancelar\b/.test(choice) ||
      /\bcancela\b/.test(choice) ||
      /\bcancel\b/.test(choice) ||
      /\bquitar\b/.test(choice) ||
      /\beliminar\b/.test(choice) ||
      /\bdelete\b/.test(choice);

    const wantsRescheduleChoice =
      choice === "2" ||
      /\breagendar\b/.test(choice) ||
      /\breprogramar\b/.test(choice) ||
      /\bcambiar\b/.test(choice) ||
      /\breschedule\b/.test(choice) ||
      /\bmove\b/.test(choice);

    if (wantsCancelChoice) {
      const nextState = updateEstimateFlowState(state, {
        action: "cancel",
        step: "ready_to_cancel",
      });

      // ✅ no responder texto intermedio engañoso;
      // dejar que el webhook haga la cancelación real inmediatamente
      return {
        handled: false,
        nextState,
      };
    }

    if (wantsRescheduleChoice) {
      const nextState = updateEstimateFlowState(state, {
        action: "reschedule",
        step: "awaiting_date",
        phone: state.phone || (contactoFallback ? normalizePhone(contactoFallback) : null),
      });

      return {
        handled: true,
        reply: askDate(lang),
        nextState,
      };
    }

    return {
      handled: true,
      reply:
        lang === "en"
          ? "Please reply with the number of the option you prefer:\n1. Cancel appointment\n2. Reschedule appointment"
          : "Por favor respóndeme con el número de la opción que prefieres:\n1. Cancelar cita\n2. Reagendar cita",
      nextState: state,
    };
  }

  // ✅ si ya está listo para cancelar, entregar control al webhook
  if (state.step === "ready_to_cancel") {
    return {
      handled: false,
      nextState: state,
    };
  }

  // =========================
  // 2) CAPTURA DE NOMBRE
  // =========================
  if (state.step === "awaiting_name") {
    const alreadyHasPhone = isLikelyPhone(cleanText(state.phone || ""));

    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      name: text,
      step: alreadyHasPhone ? "awaiting_address" : "awaiting_phone",
    });

    return {
      handled: true,
      reply: alreadyHasPhone ? askAddress(lang) : askPhone(lang, text),
      nextState,
    };
  }

  // =========================
  // 3) CAPTURA DE TELÉFONO
  // =========================
  if (state.step === "awaiting_phone") {
    if (!isLikelyPhone(text)) {
      return {
        handled: true,
        reply:
          lang === "en"
            ? "Please send me a valid phone number."
            : "Por favor envíame un número de teléfono válido.",
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      phone: normalizePhone(text),
      step: "awaiting_address",
    });

    return {
      handled: true,
      reply: askAddress(lang),
      nextState,
    };
  }

  // =========================
  // 4) CAPTURA DE DIRECCIÓN
  // =========================
  if (state.step === "awaiting_address") {
    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      address: text,
      step: "awaiting_job_type",
    });

    return {
      handled: true,
      reply: askJobType(lang),
      nextState,
    };
  }

  // =========================
  // 5) CAPTURA DE TIPO DE TRABAJO
  // =========================
  if (state.step === "awaiting_job_type") {
    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      jobType: text,
      step: "awaiting_date",
    });

    return {
      handled: true,
      reply: askDate(lang),
      nextState,
    };
  }

  // =========================
  // 6) CAPTURA DE FECHA
  // =========================
  if (state.step === "awaiting_date") {
    const parsedDate = parseFlexibleDateInput(
      text,
      lang,
      effectiveTimeZone
    );

    if (!parsedDate) {
      return {
        handled: true,
        reply:
          lang === "en"
            ? "Please send me a valid date. For example: 03/15/2026."
            : "Por favor envíame una fecha válida. Por ejemplo: 03/15/2026.",
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      preferredDate: parsedDate,
      offeredSlots: [],
      selectedSlot: null,
      step: "offering_slots",
    });

    return {
      handled: true,
      reply:
        lang === "en"
          ? "Perfect. Let me check the available times for that date."
          : "Perfecto. Déjame revisar los horarios disponibles para esa fecha.",
      nextState,
    };
  }

  // =========================
  // 7) ESPERANDO ELECCIÓN DE SLOT
  // =========================
  if (state.step === "awaiting_slot_choice") {
    console.log("[estimateFlow][awaiting_slot_choice]", {
      text,
      step: state.step,
      offeredSlots: (state as any).offeredSlots,
      offeredSlotsLen: Array.isArray((state as any).offeredSlots)
        ? (state as any).offeredSlots.length
        : null,
    });

    const raw = cleanText(text);
    const normalizedRaw = raw.toLowerCase().replace(/\s+/g, " ").trim();

    const offeredSlots = Array.isArray((state as any).offeredSlots)
      ? (state as any).offeredSlots
      : [];

    const match = normalizedRaw.match(/\b(\d{1,2})\b/);
    const idx = match ? Number(match[1]) : NaN;

    let picked: any = null;

    if (Number.isFinite(idx) && idx >= 1 && idx <= offeredSlots.length) {
      picked = offeredSlots[idx - 1];
    }

    if (!picked) {
      const normalizeHourText = (s: string) =>
        String(s || "")
          .toLowerCase()
          .replace(/\./g, "")
          .replace(/\s+/g, " ")
          .replace(/a las\s+/g, "")
          .replace(/esta bien/g, "")
          .replace(/me funciona/g, "")
          .replace(/me sirve/g, "")
          .replace(/de la tarde/g, "pm")
          .replace(/de la manana/g, "am")
          .replace(/de la mañana/g, "am")
          .trim();

      const normalizedInputHour = normalizeHourText(normalizedRaw);

      picked =
        offeredSlots.find((slot: any) => {
          const label = normalizeHourText(slot?.label || "");
          if (!label) return false;

          return (
            normalizedInputHour.includes(label) ||
            label.includes(normalizedInputHour)
          );
        }) || null;
    }

    if (!picked?.startISO || !picked?.endISO) {
      return {
        handled: true,
        reply: askSlotChoice(lang),
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
      action: state.action || null,
      selectedSlot: picked,
      preferredTime: picked.label || null,
      step: "ready_to_schedule",
    });

    return {
      handled: true,
      reply: readyMessage({
        lang,
        name: state.name,
        phone: state.phone,
        address: state.address,
        jobType: state.jobType,
        preferredDate: state.preferredDate,
        preferredTime: picked.label || null,
      }),
      nextState,
    };
  }

  if (state.step === "offering_slots") {
    return { handled: false, nextState: state };
  }

  if (state.step === "ready_to_schedule") {
    return { handled: false, nextState: state };
  }

  if (state.step === "scheduled") {
    return { handled: false, nextState: state };
  }

  return { handled: false };
}