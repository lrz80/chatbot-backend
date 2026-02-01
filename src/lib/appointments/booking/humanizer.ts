//src/lib/appointments/booking/humanizer.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type HumanizeArgs = {
  idioma: "es" | "en";
  intent:
    | "slot_exact_available"
    | "slot_exact_unavailable_with_options"
    | "ask_confirm_yes_no"
    | "ask_purpose"
    | "ask_purpose_clarify"
    | "ask_daypart"
    | "cancel_booking"
    | "ask_daypart_retry"
    | "no_availability_near_time"
    | "no_openings_that_day"
    | "no_availability_near_time";
  askedText?: string;
  prettyWhen?: string;
  optionsText?: string;
  purpose?: string;
  datePrefix?: string;
};

function fallback(args: HumanizeArgs) {
  const { idioma, intent, prettyWhen, optionsText, purpose } = args;

  if (idioma === "en") {
    if (intent === "slot_exact_available") return `Yes — I do have ${prettyWhen} available. Want me to book it?`;
    if (intent === "ask_confirm_yes_no") return `Perfect — to confirm ${prettyWhen}, reply YES or NO.`;
    if (intent === "slot_exact_unavailable_with_options") return `I don’t have that exact time. Here are the closest options:\n${optionsText}`;
    if (intent === "ask_purpose") return "Sure! What would you like to schedule?";
    if (intent === "ask_purpose_clarify") return `Got you — what are you looking to book? A class, an appointment, a consultation, or a call?`;
    if (intent === "ask_daypart") return `Perfect — for ${purpose || "that"}, does morning or afternoon work better?`;
    if (intent === "cancel_booking") return `No problem — I’ll pause this. Whenever you’re ready, just tell me.`;
    if (intent === "ask_daypart_retry") return "Got you — do you prefer morning or afternoon?";
    if (intent === "no_availability_near_time") return "I don’t see openings near that time. Would you prefer earlier or later?";
    if (intent === "no_openings_that_day") return "I don’t have openings that day. Want to try another day or morning/afternoon?";
    if (intent === "no_availability_near_time") return "I don’t see openings near that time. Would you prefer morning or afternoon?";
  }

  if (intent === "slot_exact_available") return `Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;
  if (intent === "ask_confirm_yes_no") return `Perfecto — para confirmar ${prettyWhen}, responde SI o NO.`;
  if (intent === "slot_exact_unavailable_with_options") return `No tengo esa hora exacta. Estas son las opciones más cercanas:\n${optionsText}`;
  if (intent === "ask_purpose") return "¡Claro! ¿Qué te gustaría agendar?";
  if (intent === "ask_purpose_clarify") return `Perfecto — ¿qué te gustaría agendar? ¿Clase, cita, consulta o llamada?`;
  if (intent === "ask_daypart") return `Perfecto — para ${purpose || "eso"}, ¿te funciona mejor en la mañana o en la tarde?`;
  if (intent === "cancel_booking") return `Perfecto — lo pauso por ahora. Cuando estés listo, me dices.`;
  if (intent === "ask_daypart_retry") return "Entiendo — ¿te funciona mejor en la mañana o en la tarde?";
  if (intent === "no_availability_near_time") return "No veo disponibilidad cerca de esa hora. ¿Te sirve más temprano o más tarde?";
  if (intent === "no_openings_that_day") return "Ese día no tengo disponibilidad. ¿Quieres probar otro día o prefieres mañana/tarde?";
  if (intent === "no_availability_near_time") return "No veo disponibilidad cerca de esa hora. ¿Prefieres mañana o tarde?";

  return idioma === "en" ? "Ok." : "Ok.";
}

export async function humanizeBookingReply(args: HumanizeArgs): Promise<string> {
  try {
    const { idioma, intent, askedText, prettyWhen, optionsText, purpose, datePrefix } = args;

    const system =
      idioma === "en"
        ? `You rewrite booking replies to sound natural and human for WhatsApp.
Rules:
- DO NOT invent times, dates, availability, names, emails, phone numbers, or links.
- Only use the exact details provided in the input.
- Keep it short, friendly, not robotic.
- If the intent is not confirm, do not mention YES/NO.
- If the user asked a question, answer it directly.`
        : `Reescribes respuestas de agendamiento para que suenen humanas en WhatsApp.
Reglas:
- NO inventes horas, fechas, disponibilidad, nombres, emails, teléfonos ni links.
- Solo usa los datos exactos que te paso.
- Corto, amigable, cero robótico.
- Si el intent no es confirmación, no menciones SI/NO.
- Si el usuario hizo una pregunta, respóndela directo.`;

    const payload = {
      intent,
      askedText: askedText || "",
      prettyWhen: prettyWhen || "",
      optionsText: optionsText || "",
      purpose: purpose || "",
      datePrefix: datePrefix || "",
      idioma,
    };

    const user =
      idioma === "en"
        ? `Rewrite ONE WhatsApp message using this JSON (do not add new info):\n${JSON.stringify(payload)}`
        : `Reescribe UN mensaje de WhatsApp usando este JSON (sin agregar info nueva):\n${JSON.stringify(payload)}`;

    const res = await client.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
    });

    const out = (res as any).output_text?.trim?.() || "";
    return out || fallback(args);
  } catch {
    return fallback(args);
  }
}
