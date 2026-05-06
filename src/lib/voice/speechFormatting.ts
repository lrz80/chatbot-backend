// src/lib/voice/speechFormatting.ts

export type VoiceLocale = "es-ES" | "en-US" | "pt-BR";

function normalizeWhitespace(value: string): string {
  return (value || "").replace(/\s+/g, " ").trim();
}

function isSpanishLocale(locale: string): boolean {
  return (locale || "").toLowerCase().startsWith("es");
}

function isEnglishUsLocale(locale: string): boolean {
  return (locale || "").toLowerCase() === "en-us";
}

export function verbalizeSpanishTime(hour24: number, minute: number): string {
  const period =
    hour24 < 12 ? "de la mañana" :
    hour24 < 19 ? "de la tarde" :
    "de la noche";

  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  if (minute === 0) {
    return `${hour12} ${period}`;
  }

  return `${hour12} y ${minute} ${period}`;
}

export function normalizeClockText(text: string, locale: VoiceLocale): string {
  let s = text || "";

  s = s
    .replace(/\bantes\s+del\s+meridiano\b/gi, "am")
    .replace(/\bdespu[eé]s\s+del\s+meridiano\b/gi, "pm")
    .replace(/\ba\.?\s*m\.?\b/gi, "am")
    .replace(/\bp\.?\s*m\.?\b/gi, "pm");

  if (isSpanishLocale(locale)) {
    s = s.replace(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi, (_, h, mm, ap) => {
      let hour = Number(h) % 12;
      const minute = Number(mm);

      if (String(ap).toLowerCase() === "pm") {
        hour += 12;
      }

      return verbalizeSpanishTime(hour, minute);
    });

    s = s.replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (_, h, ap) => {
      let hour = Number(h) % 12;

      if (String(ap).toLowerCase() === "pm") {
        hour += 12;
      }

      return verbalizeSpanishTime(hour, 0);
    });

    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) => {
      return verbalizeSpanishTime(Number(hh), Number(mm));
    });

    return normalizeWhitespace(s);
  }

  if (isEnglishUsLocale(locale)) {
    s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) => {
      const h = parseInt(String(hh), 10);
      const ap = h >= 12 ? "pm" : "am";
      const h12 = (h % 12) || 12;

      return `${h12}:${mm} ${ap}`;
    });

    return normalizeWhitespace(s);
  }

  s = s.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_, hh, mm) => {
    return `${parseInt(String(hh), 10).toString().padStart(2, "0")}:${mm}`;
  });

  return normalizeWhitespace(s);
}

const STREET_TYPE_MAP: Record<string, string> = {
  ave: "avenue",
  av: "avenue",
  avenue: "avenue",

  blvd: "boulevard",
  boulevard: "boulevard",

  rd: "road",
  road: "road",

  dr: "drive",
  drive: "drive",

  ln: "lane",
  lane: "lane",

  ct: "court",
  court: "court",

  cir: "circle",
  circle: "circle",

  pl: "place",
  place: "place",

  pkwy: "parkway",
  parkway: "parkway",

  hwy: "highway",
  highway: "highway",

  way: "way",
};

const STREET_TYPES_PATTERN =
  "street|avenue|boulevard|road|drive|lane|court|circle|place|parkway|highway|way";

export function expandUsStreetType(type: string, locale: VoiceLocale): string {
  const key = (type || "").toLowerCase().replace(/\./g, "");
  return STREET_TYPE_MAP[key] || type;
}

export function digitsForSpeech(value: string): string {
  return (value || "").replace(/\D/g, "").split("").join(" ");
}

function normalizeCommonStreetTypes(text: string, locale: VoiceLocale): string {
  let s = text || "";

  /**
   * Expande abreviaturas comunes aunque no haya número de calle.
   * Ejemplos:
   * - Davenport Blvd -> Davenport boulevard
   * - Hwy 50 -> highway 50
   * - Cypress Pkwy -> Cypress parkway
   *
   * No expandimos "St" globalmente para evitar romper casos como "St. Cloud".
   * "St" solo se maneja cuando parece parte de una dirección con número.
   */
  s = s.replace(
    /\b(ave|av|blvd|rd|dr|ln|ct|cir|pl|pkwy|hwy)\.?\b/gi,
    (match) => expandUsStreetType(match, locale)
  );

  /**
   * St / St. solo cuando tiene contexto de dirección:
   * 123 Main St -> 1 2 3 Main street
   */
  s = s.replace(
    new RegExp(
      String.raw`\b(\d{1,6}\s+(?:[\p{L}\p{N}'’.-]+\s+){0,8})st\.?\b`,
      "giu"
    ),
    (_, before) => `${before}street`
  );

  return normalizeWhitespace(s);
}

function normalizeDirectionalRoads(text: string): string {
  let s = text || "";

  s = s.replace(/\bUS\s*[-]?\s*(\d{1,3})\b/gi, (_, route) => {
    return `U S ${digitsForSpeech(String(route))}`;
  });

  s = s.replace(/\bSR\s*[-]?\s*(\d{1,3})\b/gi, (_, route) => {
    return `state road ${digitsForSpeech(String(route))}`;
  });

  s = s.replace(/\bCR\s*[-]?\s*(\d{1,3})\b/gi, (_, route) => {
    return `county road ${digitsForSpeech(String(route))}`;
  });

  s = s.replace(/\bI\s*[-]?\s*(\d{1,3})\b/gi, (_, route) => {
    return `interstate ${digitsForSpeech(String(route))}`;
  });

  return normalizeWhitespace(s);
}

function normalizeStreetNumbersForSpeech(text: string): string {
  let s = text || "";

  /**
   * Solo convierte números de 3 a 6 dígitos cuando parecen número de dirección,
   * no cualquier número del texto.
   *
   * Ejemplo:
   * 2200 Davenport boulevard -> 2 2 0 0 Davenport boulevard
   */
  const addressNumberRegex = new RegExp(
    String.raw`\b(\d{3,6})(?=\s+(?:[\p{L}\p{N}'’.-]+\s+){0,8}(?:${STREET_TYPES_PATTERN})\b)`,
    "giu"
  );

  s = s.replace(addressNumberRegex, (_, streetNumber) => {
    return digitsForSpeech(String(streetNumber));
  });

  return normalizeWhitespace(s);
}

function normalizeFloridaAndZipForSpeech(text: string): string {
  let s = text || "";

  s = s.replace(/\bFL\b\.?/gi, "Florida");

  /**
   * ZIP después de Florida:
   * Florida 34711 -> Florida 3 4 7 1 1
   */
  s = s.replace(/\bFlorida\s+(\d{5})(?:-(\d{4}))?\b/gi, (_, zip, extra) => {
    const combined = `${zip}${extra || ""}`;
    return `Florida ${digitsForSpeech(combined)}`;
  });

  return normalizeWhitespace(s);
}

function normalizePhoneNumbersForSpeech(text: string): string {
  let s = text || "";

  /**
   * Evita que números telefónicos se lean como cantidades.
   * Aplica solo a cadenas con formato claro de teléfono.
   */
  s = s.replace(
    /(\+?\d[\d\s().-]{7,}\d)/g,
    (match) => {
      const cleaned = String(match).replace(/[^\d+]/g, "");

      if (cleaned.replace(/\D/g, "").length < 10) {
        return match;
      }

      return cleaned
        .replace(/^\+/, "plus ")
        .split("")
        .join(" ");
    }
  );

  return normalizeWhitespace(s);
}

export function normalizeAddressForSpeech(text: string, locale: VoiceLocale): string {
  let s = text || "";

  s = normalizeDirectionalRoads(s);
  s = normalizeCommonStreetTypes(s, locale);
  s = normalizeStreetNumbersForSpeech(s);
  s = normalizeFloridaAndZipForSpeech(s);
  s = normalizePhoneNumbersForSpeech(s);

  return normalizeWhitespace(s);
}

export function normalizeSpeechOutput(text: string, locale: VoiceLocale): string {
  let s = text || "";

  s = normalizeClockText(s, locale);
  s = normalizeAddressForSpeech(s, locale);

  return normalizeWhitespace(s);
}

export function sanitizeForSay(value: string): string {
  return (value || "")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/^[\s>*_`~#-]+/gm, " ")
    .replace(/[*_`~^>#]+/g, " ")
    .replace(/[<>&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

export function twoSentencesMax(value: string): string {
  const dotToken = "__VOICE_DOT__";

  const protectedText = normalizeWhitespace(value)
    .replace(/\bSt\./g, `St${dotToken}`)
    .replace(/\bAve\./g, `Ave${dotToken}`)
    .replace(/\bBlvd\./g, `Blvd${dotToken}`)
    .replace(/\bRd\./g, `Rd${dotToken}`)
    .replace(/\bDr\./g, `Dr${dotToken}`)
    .replace(/\bLn\./g, `Ln${dotToken}`)
    .replace(/\bCt\./g, `Ct${dotToken}`)
    .replace(/\bCir\./g, `Cir${dotToken}`)
    .replace(/\bPl\./g, `Pl${dotToken}`)
    .replace(/\bPkwy\./g, `Pkwy${dotToken}`)
    .replace(/\bHwy\./g, `Hwy${dotToken}`);

  const parts = protectedText.split(/(?<=[.?!])\s+/);

  return parts
    .slice(0, 2)
    .join(" ")
    .split(dotToken)
    .join(".")
    .trim();
}