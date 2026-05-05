//src/lib/voice/voiceBookingHelpers.ts
import { traducirTexto } from "../traducirTexto";
import { normalizarNumero } from "../senders/sms";
import {
  PhoneResolutionResult,
  VoiceBookingServiceOption,
  VoiceBookingServiceResolution,
} from "./types";
import { detectTextLanguage } from "../detectTextLanguage";

type BookingSpeechCacheEntry = {
  expiresAt: number;
  value: string;
};

const BOOKING_SPEECH_TTL_MS = 60_000;
const bookingSpeechCache = new Map<string, BookingSpeechCacheEntry>();

function buildBookingSpeechCacheKey(input: {
  baseText: string;
  locale: string;
  bookingData: Record<string, string>;
  callerE164: string | null;
}) {
  const rendered = renderBookingTemplate(
    input.baseText,
    buildBookingPromptVariables({
      bookingData: input.bookingData || {},
      callerE164: input.callerE164,
    })
  ).trim();

  return `${String(input.locale || "").trim().toLowerCase()}::${rendered}`;
}

function maskForVoice(n: string) {
  return (n || "").replace(
    /^\+?(\d{0,3})\d{0,6}(\d{2})(\d{2})$/,
    (_, p, a, b) => `+${p || ""} *** ** ${a} ${b}`
  );
}

function extractDigits(t: string) {
  return (t || "").replace(/\D+/g, "");
}

function isValidE164(n?: string | null) {
  return !!n && /^\+\d{10,15}$/.test(n);
}

function normTxt(t: string) {
  return (t || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function saidYes(t: string) {
  const s = normTxt(t);
  return /\b(si|si por favor|claro|dale|ok|okay|porfa|envialo|mandalo|hazlo|yes|yep|please do|send it|text it)\b/u.test(
    s
  );
}

export function wordsToDigits(s: string) {
  if (!s) return "";

  const txt = s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s\+]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const map: Record<string, string> = {
    cero: "0",
    uno: "1",
    una: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5",
    seis: "6",
    siete: "7",
    ocho: "8",
    nueve: "9",
    diez: "10",

    zero: "0",
    oh: "0",
    o: "0",
    one: "1",
    won: "1",
    juan: "1",
    two: "2",
    too: "2",
    to: "2",
    three: "3",
    tri: "3",
    tree: "3",
    free: "3",
    four: "4",
    for: "4",
    fore: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    ate: "8",
    eit: "8",
    nine: "9",
    nain: "9",

    plus: "+",
    mas: "+",
    más: "+",
    signo: "",
    "signo+": "",
    guion: "",
    guión: "",
    dash: "",
    space: "",
    y: "",
    and: "",

    mi: "",
    numero: "",
    número: "",
    es: "",
    my: "",
    number: "",
    is: "",
    codigo: "",
    código: "",
    area: "",
    code: "",
    con: "",
    de: "",
    a: "",
    al: "",
    please: "",
    por: "",
    favor: "",
    "please,": "",
  };

  const out: string[] = [];
  for (const token of txt.split(" ")) {
    if (/^\+?\d+$/.test(token)) {
      out.push(token);
      continue;
    }

    const m = map[token];
    if (m != null) out.push(m);
  }

  let joined = out.join("");

  if ((joined.match(/\+/g) || []).length > 1) {
    joined = "+" + joined.replace(/\+/g, "");
  }

  joined = joined.replace(/[^\d+]/g, "");

  if (!joined.startsWith("+") && /^\d{10,15}$/.test(joined)) {
    joined = "+" + joined;
  }

  return joined;
}

export function renderBookingTemplate(
  template: string,
  bookingData: Record<string, string>
) {
  let output = template || "";

  for (const [key, value] of Object.entries(bookingData || {})) {
    output = output.split(`{${key}}`).join(value || "");
  }

  return output.trim();
}

function normalizeLocaleKey(locale: string) {
  const value = String(locale || "").trim();

  if (!value) return "";

  if (value.startsWith("es")) return "es-ES";
  if (value.startsWith("en")) return "en-US";
  if (value.startsWith("pt")) return "pt-BR";

  return value;
}

function pickLocalizedBookingText(params: {
  locale: string;
  translations?: Record<string, unknown> | null;
  fallbackText?: string | null;
}) {
  const localeKey = normalizeLocaleKey(params.locale);
  const translations = params.translations || {};

  const exact =
    typeof translations[localeKey] === "string"
      ? String(translations[localeKey]).trim()
      : "";

  if (exact) return exact;

  const languagePrefix = localeKey.split("-")[0];

  const prefixedEntry = Object.entries(translations).find(([key, value]) => {
    return (
      typeof value === "string" &&
      String(key || "").toLowerCase().startsWith(languagePrefix.toLowerCase())
    );
  });

  if (prefixedEntry && typeof prefixedEntry[1] === "string") {
    const value = String(prefixedEntry[1]).trim();
    if (value) return value;
  }

  const fallback = String(params.fallbackText || "").trim();
  return fallback;
}

export function resolveBookingPromptText(params: {
  locale: string;
  prompt?: string | null;
  promptTranslations?: Record<string, unknown> | null;
}) {
  return pickLocalizedBookingText({
    locale: params.locale,
    translations: params.promptTranslations,
    fallbackText: params.prompt,
  });
}

export function resolveBookingRetryText(params: {
  locale: string;
  retryPrompt?: string | null;
  retryPromptTranslations?: Record<string, unknown> | null;
  fallbackPrompt?: string | null;
  fallbackPromptTranslations?: Record<string, unknown> | null;
}) {
  const localizedRetry = pickLocalizedBookingText({
    locale: params.locale,
    translations: params.retryPromptTranslations,
    fallbackText: params.retryPrompt,
  });

  if (localizedRetry) {
    return localizedRetry;
  }

  return pickLocalizedBookingText({
    locale: params.locale,
    translations: params.fallbackPromptTranslations,
    fallbackText: params.fallbackPrompt,
  });
}

export function buildBookingPromptVariables(params: {
  bookingData: Record<string, string>;
  callerE164: string | null;
}) {
  return {
    ...params.bookingData,
    current_phone: params.callerE164 || "",
    current_phone_masked: params.callerE164
      ? maskForVoice(params.callerE164)
      : "",
  };
}

export function resolveBookingFlowSpeech(params: {
  baseText: string;
  locale: string;
  bookingData: Record<string, string>;
  callerE164: string | null;
}) {
  const rendered = renderBookingTemplate(
    params.baseText,
    buildBookingPromptVariables({
      bookingData: params.bookingData || {},
      callerE164: params.callerE164,
    })
  ).trim();

  if (!rendered) return "";

  const cacheKey = buildBookingSpeechCacheKey({
    baseText: params.baseText,
    locale: params.locale,
    bookingData: params.bookingData,
    callerE164: params.callerE164,
  });

  const now = Date.now();
  const cached = bookingSpeechCache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  bookingSpeechCache.set(cacheKey, {
    expiresAt: now + BOOKING_SPEECH_TTL_MS,
    value: rendered,
  });

  return rendered;
}

export function buildAnswersBySlot(params: {
  flow: Array<any>;
  bookingData: Record<string, string>;
}) {
  const answersBySlot: Record<string, string> = {};

  for (const step of params.flow) {
    const rawSlot = step.validation_config?.slot;
    const slot = typeof rawSlot === "string" ? rawSlot.trim() : "";

    if (!slot || slot === "none") continue;

    const value = params.bookingData?.[step.step_key];
    if (!value) continue;

    answersBySlot[slot] = value;
  }

  return answersBySlot;
}

export function resolveBookingSuccessStep(params: {
  flow: Array<any>;
}) {
  return params.flow.find((step) => {
    if (!step.enabled) return false;
    if (step.expected_type !== "text") return false;
    if (step.required) return false;

    const slot =
      typeof step.validation_config?.slot === "string"
        ? step.validation_config.slot.trim()
        : "";

    return slot === "none";
  });
}

function normalizeVoiceServiceText(value: string) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseVoiceBookingServices(raw: string): VoiceBookingServiceOption[] {
  return (raw || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [canonicalPart, aliasesPart = ""] = line.split("|");
      const value = (canonicalPart || "").trim();

      const aliases = aliasesPart
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);

      if (!value) return null;

      return {
        value,
        aliases,
      };
    })
    .filter((item): item is VoiceBookingServiceOption => Boolean(item));
}

function scoreVoiceBookingCandidate(userInput: string, candidate: string): number {
  const normalizedInput = normalizeVoiceServiceText(userInput);
  const normalizedCandidate = normalizeVoiceServiceText(candidate);

  if (!normalizedInput || !normalizedCandidate) return 0;

  if (normalizedInput === normalizedCandidate) return 100;

  if (
    normalizedInput.includes(normalizedCandidate) ||
    normalizedCandidate.includes(normalizedInput)
  ) {
    return 85;
  }

  const inputTokens = new Set(normalizedInput.split(" ").filter(Boolean));
  const candidateTokens = normalizedCandidate.split(" ").filter(Boolean);

  if (!candidateTokens.length) return 0;

  const overlap = candidateTokens.filter((token) => inputTokens.has(token)).length;
  const coverage = overlap / candidateTokens.length;

  if (coverage >= 0.8) return 75;
  if (coverage >= 0.6) return 60;
  if (coverage >= 0.4) return 40;

  return 0;
}

export function resolveVoiceBookingService(params: {
  userInput: string;
  rawConfig: string;
}): VoiceBookingServiceResolution {
  const normalizedInput = normalizeVoiceServiceText(params.userInput);
  const options = parseVoiceBookingServices(params.rawConfig);

  if (!normalizedInput || !options.length) {
    return { kind: "none" };
  }

  const ranked = options
    .map((option) => {
      const candidates = [option.value, ...option.aliases];
      const bestScore = Math.max(
        ...candidates.map((candidate) =>
          scoreVoiceBookingCandidate(params.userInput, candidate)
        )
      );

      return {
        value: option.value,
        score: bestScore,
      };
    })
    .filter((item) => item.score >= 60)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { kind: "none" };
  }

  const top = ranked[0];
  const second = ranked[1];

  if (top.score >= 85 && (!second || top.score - second.score >= 15)) {
    return {
      kind: "resolved_single",
      value: top.value,
    };
  }

  const ambiguousOptions = ranked.slice(0, 4).map((item) => item.value);

  if (ambiguousOptions.length === 1) {
    return {
      kind: "resolved_single",
      value: ambiguousOptions[0],
    };
  }

  return {
    kind: "ambiguous",
    options: ambiguousOptions,
  };
}

export function resolvePhoneFromVoiceInput(params: {
  userInput: string;
  digits: string;
  callerE164: string | null;
  step: any;
}): PhoneResolutionResult {
  const raw = (params.userInput || params.digits || "").trim();
  const config = params.step?.validation_config || {};
  const mode = typeof config.mode === "string" ? config.mode : "free_input";
  const useInboundCaller = !!config.use_inbound_caller;

  const spoken = wordsToDigits(raw || "");
  const digitsOnly = extractDigits(spoken || raw || "");

  if (digitsOnly) {
    const normalized = normalizarNumero(`+${digitsOnly}`);
    if (isValidE164(normalized)) {
      return { ok: true, value: normalized };
    }
  }

  if (
    useInboundCaller &&
    params.callerE164 &&
    isValidE164(params.callerE164) &&
    (mode === "confirm_or_replace" || mode === "inbound_caller")
  ) {
    return { ok: true, value: params.callerE164 };
  }

  if (
    mode === "confirm_or_replace" &&
    useInboundCaller &&
    params.callerE164 &&
    isValidE164(params.callerE164) &&
    (saidYes(raw) || params.digits === "1")
  ) {
    return { ok: true, value: params.callerE164 };
  }

  return { ok: false };
}