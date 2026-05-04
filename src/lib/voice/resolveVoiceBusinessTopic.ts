// src/lib/voice/resolveVoiceBusinessTopic.ts

import { LinkType } from "./types";

export type VoiceBusinessTopic = "precios" | "horarios" | "ubicacion" | "pagos";

export type ResolveVoiceBusinessTopicResult =
  | {
      matched: true;
      topic: VoiceBusinessTopic;
      linkType: LinkType;
    }
  | {
      matched: false;
      topic: null;
      linkType: null;
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

export function resolveVoiceBusinessTopic(
  value: string
): ResolveVoiceBusinessTopicResult {
  const s = normalizeText(value);

  if (/\b(precio|precios|tarifa|tarifas|cost|price|prices)\b/u.test(s)) {
    return {
      matched: true,
      topic: "precios",
      linkType: "comprar",
    };
  }

  if (/\b(horario|horarios|abren|cierran|hours|open|close)\b/u.test(s)) {
    return {
      matched: true,
      topic: "horarios",
      linkType: "web",
    };
  }

  if (/\b(ubicacion|direccion|donde|address|location|mapa|maps)\b/u.test(s)) {
    return {
      matched: true,
      topic: "ubicacion",
      linkType: "web",
    };
  }

  if (/\b(pago|pagar|checkout|buy|pay|payment|payments)\b/u.test(s)) {
    return {
      matched: true,
      topic: "pagos",
      linkType: "comprar",
    };
  }

  return {
    matched: false,
    topic: null,
    linkType: null,
  };
}