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
      if (String(ap).toLowerCase() === "pm") hour += 12;
      return verbalizeSpanishTime(hour, minute);
    });

    s = s.replace(/\b(\d{1,2})\s*(am|pm)\b/gi, (_, h, ap) => {
      let hour = Number(h) % 12;
      if (String(ap).toLowerCase() === "pm") hour += 12;
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

export function expandUsStreetType(type: string, locale: VoiceLocale): string {
  const key = (type || "").toLowerCase().replace(/\./g, "");

  const map: Record<string, string> = {
    st: "Street",
    ave: "Avenue",
    blvd: "Boulevard",
    rd: "Road",
    dr: "Drive",
    ln: "Lane",
    ct: "Court",
    cir: "Circle",
    pl: "Place",
    pkwy: "Parkway",
    hwy: "Highway",
  };

  return map[key] || type;
}

export function digitsForSpeech(value: string): string {
  return (value || "").split("").join(" ");
}

export function normalizeAddressForSpeech(text: string, locale: VoiceLocale): string {
  let s = text || "";
  const isES = isSpanishLocale(locale);

  s = s.replace(
    /\b(\d{3,6})\s+([A-Za-zÀ-ÿ0-9'’.-]+(?:\s+[A-Za-zÀ-ÿ0-9'’.-]+)*)\s+(St|Ave|Blvd|Rd|Dr|Ln|Ct|Cir|Pl|Pkwy|Hwy)\b\.?/gi,
    (_, streetNumber, streetName, streetType) => {
      const spokenNumber = digitsForSpeech(String(streetNumber));
      const spokenType = expandUsStreetType(String(streetType), locale);
      return `${spokenNumber} ${streetName} ${spokenType}`;
    }
  );

  s = s.replace(/\bFL\b/g, isES ? "Florida" : "Florida");

  s = s.replace(/\b(\d{5})(-\d{4})?\b/g, (_, zip, extra) => {
    const all = `${zip}${extra || ""}`.replace(/-/g, "");
    return digitsForSpeech(all);
  });

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
    .replace(/[*_`~^>#-]+/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/[<>&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1500);
}

export function twoSentencesMax(value: string): string {
  const parts = normalizeWhitespace(value).split(/(?<=[\.\?\!])\s+/);
  return parts.slice(0, 2).join(" ").trim();
}