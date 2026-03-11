// backend/src/lib/estimateFlow/handleEstimateFlowTurn.ts

import type { Lang } from "../channels/engine/clients/clientDb";
import type { EstimateFlowState } from "./types";
import { createEmptyEstimateFlowState } from "./types";
import { updateEstimateFlowState } from "./updateEstimateFlowState";

type HandleEstimateFlowTurnArgs = {
  userInput: string;
  lang: Lang;
  canal?: string | null;
  currentState?: EstimateFlowState | null;
  contactoFallback?: string | null;
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

    // ✅ nuevo: disparadores explícitos naturales
    /\bquiero agendar\b/.test(t) ||
    /\bquiero reservar\b/.test(t) ||
    /\bagendar\b/.test(t) ||
    /\breservar\b/.test(t) ||
    /\bschedule\b/.test(t) ||
    /\bbook\b/.test(t)
  );
}

function isValidDateInput(text: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(cleanText(text));
}

function isValidTimeInput(text: string) {
  const t = cleanText(text).toUpperCase();
  return /^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/.test(t);
}

function askName(lang: Lang) {
  return lang === "en"
    ? "Sure 😊 To schedule your estimate, first tell me your full name."
    : "Claro 😊 Para agendar tu estimado, primero dime tu nombre completo.";
}

function askPhone(lang: Lang, name?: string | null) {
  return lang === "en"
    ? `${name ? `Perfect, ${name}. ` : ""}What is your best phone number?`
    : `${name ? `Perfecto, ${name}. ` : ""}¿Cuál es tu mejor número de teléfono?`;
}

function askAddress(lang: Lang) {
  return lang === "en"
    ? "Thanks. What is the address where the work would be done?"
    : "Gracias. ¿Cuál es la dirección donde sería el trabajo?";
}

function askJobType(lang: Lang) {
  return lang === "en"
    ? "Got it. What type of work do you need exactly?"
    : "Entendido. ¿Qué tipo de trabajo necesitas exactamente?";
}

function askDate(lang: Lang) {
  return lang === "en"
    ? "Perfect. What date works best for the estimate? Please send it in YYYY-MM-DD format."
    : "Perfecto. ¿Qué fecha te funciona mejor para el estimado? Envíamela en formato YYYY-MM-DD.";
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
      "Perfect 😊 I already have the information for your estimate:",
      name ? `• Name: ${name}` : "",
      phone ? `• Phone: ${phone}` : "",
      address ? `• Address: ${address}` : "",
      jobType ? `• Work type: ${jobType}` : "",
      preferredDate ? `• Date: ${preferredDate}` : "",
      preferredTime ? `• Time: ${preferredTime}` : "",
      "",
      "Now I’m going to try to schedule the estimate automatically.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return [
    "Perfecto 😊 Ya tengo la información para tu estimado:",
    name ? `• Nombre: ${name}` : "",
    phone ? `• Teléfono: ${phone}` : "",
    address ? `• Dirección: ${address}` : "",
    jobType ? `• Tipo de trabajo: ${jobType}` : "",
    preferredDate ? `• Fecha: ${preferredDate}` : "",
    preferredTime ? `• Hora: ${preferredTime}` : "",
    "",
    "Ahora voy a intentar agendar el estimado automáticamente.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function handleEstimateFlowTurn(
  args: HandleEstimateFlowTurnArgs
): HandleEstimateFlowTurnResult {
  const { userInput, lang, canal, currentState, contactoFallback } = args;

  const text = cleanText(userInput);
  const state = currentState?.active
    ? currentState
    : createEmptyEstimateFlowState();

  // =========================
  // 1) ARRANQUE DEL FLUJO
  // =========================
  if (!state.active) {
    if (!looksLikeStartEstimateIntent(text)) {
      return { handled: false };
    }

    const nextState = updateEstimateFlowState(state, {
      active: true,
      step: "awaiting_name",
      phone: contactoFallback ? normalizePhone(contactoFallback) : null,
    });

    return {
      handled: true,
      reply: askName(lang),
      nextState,
    };
  }

  // =========================
  // 2) CAPTURA DE NOMBRE
  // =========================
  if (state.step === "awaiting_name") {
    const alreadyHasPhone = isLikelyPhone(cleanText(state.phone || ""));

    const nextState = updateEstimateFlowState(state, {
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
            ? "Please send me a valid phone number so I can continue with the estimate."
            : "Por favor envíame un número de teléfono válido para poder continuar con el estimado.",
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
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
    if (!isValidDateInput(text)) {
      return {
        handled: true,
        reply:
          lang === "en"
            ? "Please send the date in YYYY-MM-DD format. Example: 2026-03-15"
            : "Por favor envíame la fecha en formato YYYY-MM-DD. Ejemplo: 2026-03-15",
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
      preferredDate: text,
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
    const raw = cleanText(text);
    const idx = Number(raw);

    if (!Number.isFinite(idx) || idx < 1) {
      return {
        handled: true,
        reply: askSlotChoice(lang),
        nextState: state,
      };
    }

    const offeredSlots = Array.isArray((state as any).offeredSlots)
      ? (state as any).offeredSlots
      : [];

    const picked = offeredSlots[idx - 1];

    if (!picked?.startISO || !picked?.endISO) {
      return {
        handled: true,
        reply:
          lang === "en"
            ? "That option is no longer valid. Please choose one of the available time options."
            : "Esa opción ya no es válida. Por favor elige uno de los horarios disponibles.",
        nextState: state,
      };
    }

    const nextState = updateEstimateFlowState(state, {
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