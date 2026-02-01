//src/lib/appointments/booking/humanizer.ts
import OpenAI from "openai";

const HUMANIZER_DEBUG = process.env.HUMANIZER_DEBUG === "1";

function hlog(...args: any[]) {
  if (HUMANIZER_DEBUG) console.log("🤖[HUMANIZER]", ...args);
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type BookingHumanizeIntent =
  | "slot_exact_available"
  | "slot_exact_unavailable_with_options"
  | "ask_confirm_yes_no"
  | "ask_purpose"
  | "ask_purpose_clarify"
  | "ask_daypart"
  | "cancel_booking"
  | "ask_daypart_retry"
  | "no_openings_that_day"
  | "no_availability_near_time"
  | "past_slot"
  | "past_date"
  | "ask_time_for_date"
  | "offer_slots_for_date"
  | "ask_missing_field"
  | "ask_datetime_format"
  | "ask_other_time";;

export type HumanizeArgs = {
  idioma: "es" | "en";
  intent: BookingHumanizeIntent;
  askedText?: string;
  canonicalText: string;
  locked?: string[];
  prettyWhen?: string;
  optionsText?: string;
  purpose?: string;
  datePrefix?: string;
};

function fallback(args: HumanizeArgs) {
  const { idioma, intent, prettyWhen, optionsText, purpose, datePrefix } = args;

  const basePrefix = datePrefix || "";

  if (idioma === "en") {
    if (intent === "slot_exact_available") return `Yes — I do have ${prettyWhen} available. Want me to book it?`;
    if (intent === "ask_confirm_yes_no") return `Perfect — to confirm ${prettyWhen}, reply YES or NO.`;
    if (intent === "slot_exact_unavailable_with_options")
      return `${basePrefix}I don’t have that exact time. Here are the closest options:\n${optionsText}`;
    if (intent === "ask_purpose") return "Sure — what would you like to schedule?";
    if (intent === "ask_purpose_clarify") return "Got you — what are you looking to book? A class, an appointment, a consultation, or a call?";
    if (intent === "ask_daypart") return `Perfect — for ${purpose || "that"}, does morning or afternoon work better?`;
    if (intent === "cancel_booking") return "No problem — I’ll pause this. Whenever you’re ready, just tell me.";
    if (intent === "ask_daypart_retry") return "Quick one — morning or afternoon?";
    if (intent === "no_openings_that_day") return "I don’t have openings that day. Want to try another date?";
    if (intent === "no_availability_near_time") return "I don’t see openings near that time. Would you like something earlier or later?";
    if (intent === "ask_other_time") return "Got it — what other time works for you?";

    // ✅ nuevos
    if (intent === "past_slot") return "That date/time is in the past. Please send a future date and time (example: 2026-01-21 14:00).";
    if (intent === "past_date") return "That date is in the past. Please send a future date (YYYY-MM-DD).";
    if (intent === "ask_time_for_date") return "Got it — what time works for you that day? Reply with HH:mm (example: 14:00).";
    if (intent === "offer_slots_for_date") return `Perfect — here are a few options:\n${optionsText}`;
    if (intent === "ask_missing_field") return "I’m missing one detail — can you send it again?";
    if (intent === "ask_datetime_format") return "I’m missing the date and time. Please use: YYYY-MM-DD HH:mm (example: 2026-01-21 14:00).";
    if (intent === "ask_other_time") return "Perfecto — ¿qué otra hora te funciona?";

  }

  // ES
  if (intent === "slot_exact_available") return `Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;
  if (intent === "ask_confirm_yes_no") return `Perfecto — para confirmar ${prettyWhen}, responde SI o NO.`;
  if (intent === "slot_exact_unavailable_with_options")
    return `${basePrefix}No tengo esa hora exacta. Estas son las opciones más cercanas:\n${optionsText}`;
  if (intent === "ask_purpose") return "¡Claro! ¿Qué te gustaría agendar?";
  if (intent === "ask_purpose_clarify") return "Perfecto — ¿qué te gustaría agendar? ¿Clase, cita, consulta o llamada?";
  if (intent === "ask_daypart") return `Perfecto — para ${purpose || "eso"}, ¿te funciona mejor en la mañana o en la tarde?`;
  if (intent === "cancel_booking") return "Perfecto — lo pauso por ahora. Cuando estés listo, me dices.";
  if (intent === "ask_daypart_retry") return "Rápido: ¿mañana o tarde?";
  if (intent === "no_openings_that_day") return "Ese día no tengo disponibilidad. ¿Probamos otra fecha?";
  if (intent === "no_availability_near_time") return "No veo disponibilidad cerca de esa hora. ¿Te sirve más temprano o más tarde?";

  // ✅ nuevos
  if (intent === "past_slot") return "Esa fecha/hora ya pasó. Envíame una fecha y hora futura (ej: 2026-01-21 14:00).";
  if (intent === "past_date") return "Esa fecha ya pasó. Envíame una fecha futura (YYYY-MM-DD).";
  if (intent === "ask_time_for_date") return "Perfecto — ¿a qué hora te gustaría ese día? Respóndeme con HH:mm (ej: 14:00).";
  if (intent === "offer_slots_for_date") return `Perfecto — aquí tienes algunas opciones:\n${optionsText}`;
  if (intent === "ask_missing_field") return "Me falta un detalle — ¿me lo envías otra vez?";
  if (intent === "ask_datetime_format") return "Me falta la fecha y la hora. Usa: YYYY-MM-DD HH:mm (ej: 2026-01-21 14:00).";

  return idioma === "en" ? "Ok." : "Ok.";
}

function fallbackFromCanonical(args: HumanizeArgs) {
  return args.canonicalText || fallback(args);
}

function respectsLocked(out: string, locked: string[] = []) {
  for (const chunk of locked) {
    if (!chunk) continue;
    if (!out.includes(chunk)) return false;
  }
  return true;
}

// ✅ (opcional) también evitamos que el modelo meta "sí/no" si no es confirm
function confirmWordsViolation(out: string, intent: BookingHumanizeIntent, idioma: "es" | "en") {
  // Solo permitimos pedir "SI/NO" cuando el intent es confirmación.
  if (intent === "ask_confirm_yes_no") return false;

  const s = (out || "").toLowerCase();

  // Bloquea SOLO frases que pidan explícitamente confirmar con SI/NO,
  // no la palabra "no" usada en una oración normal.
  if (idioma === "en") {
    return /\b(reply|respond)\s+(yes|no)\b/.test(s) || /\byes\/no\b/.test(s);
  }

  return (
    /\b(responde|contesta)\s+(si|sí|no)\b/.test(s) ||
    /\b(si\/no|sí\/no)\b/.test(s)
  );
}

export async function humanizeBookingReply(args: HumanizeArgs): Promise<string> {
  const {
    canonicalText,
    locked = [],
  } = args;

  // ✅ Si no hay API key, no arriesgamos: devolvemos el canónico
  if (!process.env.OPENAI_API_KEY) {
    hlog("NO_API_KEY", { intent: args.intent, idioma: args.idioma });
    return fallbackFromCanonical(args);
  }

  try {
    const { idioma, intent, askedText, prettyWhen, optionsText, purpose, datePrefix } = args;

    const system =
      idioma === "en"
        ? `You rewrite ONE WhatsApp message to sound natural.
    STRICT RULES (must follow):
    - Do NOT change the meaning of the message.
    - Do NOT add or remove availability.
    - Do NOT add times, dates, options, names, emails, phones, or links.
    - If there are LOCKED chunks, you MUST keep them EXACTLY as-is (character by character).
    - If the intent is not confirm, do not mention YES/NO.
    - Output only the final message, no explanations.`
        : `Reescribes UN mensaje de WhatsApp para que suene natural.
    REGLAS ESTRICTAS:
    - NO cambies el significado del mensaje.
    - NO inventes ni quites disponibilidad.
    - NO agregues horas, fechas, opciones, nombres, emails, teléfonos ni links.
    - Si hay fragmentos LOCKED, debes copiarlos EXACTAMENTE iguales (carácter por carácter).
    - Si el intent no es confirmación, no menciones SI/NO.
    - Devuelve solo el mensaje final, sin explicación.`;

    const payload = {
      intent,
      idioma,
      askedText: askedText || "",
      canonicalText,
      locked,
      // extras opcionales (por si en el futuro quieres analizar)
      prettyWhen: prettyWhen || "",
      optionsText: optionsText || "",
      purpose: purpose || "",
      datePrefix: datePrefix || "",
    };

    const user =
      idioma === "en"
        ? `Rewrite the CANONICAL message to sound more human, WITHOUT changing meaning.
    LOCKED chunks must remain EXACTLY unchanged.

    JSON:
    ${JSON.stringify(payload)}`
            : `Reescribe el mensaje CANÓNICO para que suene más humano, SIN cambiar el significado.
    Los fragmentos LOCKED deben quedar EXACTAMENTE iguales.

    JSON:
    ${JSON.stringify(payload)}`;

    const res = await client.responses.create({
      model: "gpt-40-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
    });

    const out = (res as any).output_text?.trim?.() || "";
    if (!out) {
    hlog("EMPTY_OUTPUT", { intent, idioma, canonicalText });
    return fallbackFromCanonical(args);
    }

    // ✅ Si violó locked -> NO se usa
    if (!respectsLocked(out, locked)) {
      hlog("LOCKED_VIOLATION", { intent, idioma, locked, out, canonicalText });
      return canonicalText;
    }

    // ✅ Si metió YES/NO cuando no debe -> NO se usa
    if (confirmWordsViolation(out, intent, idioma)) {
      hlog("CONFIRM_WORDS_VIOLATION", { intent, idioma, out, canonicalText });
      return canonicalText;
    }

    hlog("OK_HUMANIZED", { intent, idioma, out });

    return out;
  } catch (e: any) {
    hlog("OPENAI_ERROR", { intent: args.intent, idioma: args.idioma, error: String(e?.message || e) });
    // en error, nunca “inventamos”: devolvemos el canónico
    return fallbackFromCanonical(args);
  }
}