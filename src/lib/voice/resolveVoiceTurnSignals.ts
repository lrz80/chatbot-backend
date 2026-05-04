// src/lib/voice/resolveVoiceTurnSignals.ts

import { LinkType } from "./types";

export type VoiceTurnSignals = {
  normalizedText: string;
  extractedDigits: string;
  smsRequested: boolean;
  assistantPromisedSms: boolean;
  smsConfirmation: false;
  smsRejection: false;
  guessedLinkType: LinkType;
  coercedMenuDigit?: "1" | "2" | "3" | "4";
};

function normalizeText(value: string): string {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractDigits(value: string): string {
  return (value || "").replace(/\D+/g, "");
}

export function askedForSms(value: string): boolean {
  const s = (value || "").toLowerCase();

  const wantsSms =
    /(\bsms\b|\bmensaje\b|\btexto\b|\bmand(a|e|alo)\b|\benv[ií]a(lo)?\b|\btext\b|\btext me\b|\bmessage me\b)/i.test(
      s
    );

  if (!wantsSms) {
    return false;
  }

  const mentionsLink =
    /link|enlace|liga|url|p[aá]gina|web|reserv|agend|cita|turno|compr|pag|pago|checkout|soporte|support/i.test(
      s
    );

  return mentionsLink || true;
}

export function didAssistantPromiseSms(value: string): boolean {
  const s = normalizeText(value);

  return /\b(te lo envio por sms|te lo mando por sms|te lo enviare por sms|te lo envio por mensaje|te lo mando por mensaje|ill text it to you|ill send it by text)\b/u.test(
    s
  );
}

export function guessLinkType(value: string): LinkType {
  const s = (value || "").toLowerCase();

  if (/(reserv|agend|cita|turno|booking|appointment)/.test(s)) {
    return "reservar";
  }

  if (/(compr|pag|pago|checkout|buy|pay|payment)/.test(s)) {
    return "comprar";
  }

  if (/(soporte|support|ticket|help|ayuda)/.test(s)) {
    return "soporte";
  }

  if (/(web|sitio|p[aá]gina|home|website)/.test(s)) {
    return "web";
  }

  return "reservar";
}

export function coerceSpeechToMenuDigit(
  value: string
): "1" | "2" | "3" | "4" | undefined {
  const w = normalizeText(value);

  if (
    /\b(precio|precios|tarifa|tarifas|price|prices|pagar|pago|checkout|buy|pay|payment)\b/u.test(
      w
    )
  ) {
    return "1";
  }

  if (
    /\b(horario|horarios|hours|open|close|abren|cierran)\b/u.test(w)
  ) {
    return "2";
  }

  if (
    /\b(ubicacion|direccion|address|location|mapa|maps|google maps)\b/u.test(w)
  ) {
    return "3";
  }

  if (
    /\b(representante|humano|agente|persona|operator|representative)\b/u.test(w)
  ) {
    return "4";
  }

  if (/^(1|one|uno)\b/u.test(w)) {
    return "1";
  }

  if (/^(2|two|dos)\b/u.test(w)) {
    return "2";
  }

  if (/^(3|three|tres)\b/u.test(w)) {
    return "3";
  }

  if (/^(4|four|for)\b/u.test(w)) {
    return "4";
  }

  return undefined;
}

export function resolveVoiceTurnSignals(value: string): VoiceTurnSignals {
  return {
    normalizedText: normalizeText(value),
    extractedDigits: extractDigits(value),
    smsRequested: askedForSms(value),
    assistantPromisedSms: didAssistantPromiseSms(value),
    smsConfirmation: false,
    smsRejection: false,
    guessedLinkType: guessLinkType(value),
    coercedMenuDigit: coerceSpeechToMenuDigit(value),
  };
}