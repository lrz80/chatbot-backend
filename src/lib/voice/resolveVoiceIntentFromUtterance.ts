//src/lib/voice/resolveVoiceIntentFromUtterance.ts
export type VoiceIntent =
  | "booking"
  | "prices"
  | "hours"
  | "location"
  | "human_handoff"
  | "unknown";

function normalizeUtterance(input: string) {
  return (input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function includesAny(text: string, phrases: string[]) {
  return phrases.some((phrase) => text.includes(phrase));
}

export function resolveVoiceIntentFromUtterance(input: string): VoiceIntent {
  const text = normalizeUtterance(input);

  if (!text) return "unknown";

  const bookingSignals = [
    "agendar",
    "agenda",
    "reservar",
    "reserva",
    "cita",
    "appointment",
    "book",
    "booking",
    "schedule",
    "quiero agendar",
    "quiero reservar",
    "hacer una cita",
    "me gustaria agendar",
    "me gustaria reservar",
  ];

  const priceSignals = [
    "precio",
    "precios",
    "price",
    "prices",
    "cost",
    "cuanto cuesta",
  ];

  const hourSignals = [
    "horario",
    "horarios",
    "hours",
    "schedule",
    "abren",
    "cierran",
  ];

  const locationSignals = [
    "ubicacion",
    "direccion",
    "donde estan",
    "location",
    "address",
    "where are you located",
  ];

  const humanSignals = [
    "representante",
    "humano",
    "agente",
    "persona",
    "representative",
    "agent",
    "someone",
    "hablar con alguien",
  ];

  if (includesAny(text, bookingSignals)) return "booking";
  if (includesAny(text, priceSignals)) return "prices";
  if (includesAny(text, hourSignals)) return "hours";
  if (includesAny(text, locationSignals)) return "location";
  if (includesAny(text, humanSignals)) return "human_handoff";

  return "unknown";
}