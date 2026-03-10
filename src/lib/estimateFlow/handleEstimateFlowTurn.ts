// backend/src/lib/estimateFlow/handleEstimateFlowTurn.ts

import type { Lang } from "../channels/engine/clients/clientDb";
import type { EstimateFlowState } from "./types";
import { createEmptyEstimateFlowState } from "./types";
import { updateEstimateFlowState } from "./updateEstimateFlowState";

type HandleEstimateFlowTurnArgs = {
  userInput: string;
  lang: Lang;
  currentState?: EstimateFlowState | null;
  contactoFallback?: string | null; // por si quieres usar el número inbound como fallback
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
    /\bon site estimate\b/.test(t)
  );
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

function readyMessage(args: {
  lang: Lang;
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  jobType?: string | null;
}) {
  const { lang, name, phone, address, jobType } = args;

  if (lang === "en") {
    return [
      "Perfect 😊 I already have the information for your estimate:",
      name ? `• Name: ${name}` : "",
      phone ? `• Phone: ${phone}` : "",
      address ? `• Address: ${address}` : "",
      jobType ? `• Work type: ${jobType}` : "",
      "",
      "Now I can continue with the next step to schedule the estimate.",
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
    "",
    "Ahora ya puedo seguir con el próximo paso para agendar el estimado.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function handleEstimateFlowTurn(
  args: HandleEstimateFlowTurnArgs
): HandleEstimateFlowTurnResult {
  const { userInput, lang, currentState, contactoFallback } = args;

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
    const nextState = updateEstimateFlowState(state, {
      name: text,
      step: "awaiting_phone",
    });

    return {
      handled: true,
      reply: askPhone(lang, text),
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
      step: "ready_to_schedule",
    });

    return {
      handled: true,
      reply: readyMessage({
        lang,
        name: state.name,
        phone: state.phone,
        address: state.address,
        jobType: text,
      }),
      nextState,
    };
  }

  // =========================
  // 6) YA LISTO
  // =========================
  if (state.step === "ready_to_schedule") {
    return {
      handled: false,
      nextState: state,
    };
  }

  return { handled: false };
}