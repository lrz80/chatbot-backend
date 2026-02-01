//src/lib/appointments/booking/humanizer.ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type HumanizeArgs = {
  idioma: "es" | "en";
  intent:
    | "slot_exact_available"
    | "slot_exact_unavailable_with_options"
    | "ask_confirm_yes_no";
  // datos 100% controlados por tu lógica (no inventados)
  askedText?: string;          // texto original del cliente (opcional)
  prettyWhen?: string;         // "lunes 2 feb, 1:00 p. m."
  optionsText?: string;        // lista ya renderizada de opciones (si aplica)
};

function fallback(args: HumanizeArgs) {
  const { idioma, intent, prettyWhen, optionsText } = args;

  if (idioma === "en") {
    if (intent === "slot_exact_available") return `Yes — I do have ${prettyWhen} available. Want me to book it?`;
    if (intent === "ask_confirm_yes_no") return `Perfect — to confirm ${prettyWhen}, reply YES or NO.`;
    if (intent === "slot_exact_unavailable_with_options") return `I don’t have that exact time. Here are the closest options:\n${optionsText}`;
  }

  if (intent === "slot_exact_available") return `Sí — tengo ${prettyWhen} disponible. ¿Quieres que la reserve?`;
  if (intent === "ask_confirm_yes_no") return `Perfecto — para confirmar ${prettyWhen}, responde SI o NO.`;
  if (intent === "slot_exact_unavailable_with_options") return `No tengo esa hora exacta. Estas son las opciones más cercanas:\n${optionsText}`;

  return idioma === "en" ? "Ok." : "Ok.";
}

export async function humanizeBookingReply(args: HumanizeArgs): Promise<string> {
  try {
    const { idioma, intent, askedText, prettyWhen, optionsText } = args;

    const system =
      idioma === "en"
        ? `You rewrite booking replies to sound natural and human for WhatsApp.
Rules:
- DO NOT invent times, dates, availability, names, emails, phone numbers, or links.
- Only use the exact details provided in the input.
- Keep it short, friendly, not robotic.
- If the user asked a question, answer it directly.`
        : `Reescribes respuestas de agendamiento para que suenen humanas en WhatsApp.
Reglas:
- NO inventes horas, fechas, disponibilidad, nombres, emails, teléfonos ni links.
- Solo usa los datos exactos que te paso.
- Corto, amigable, cero robótico.
- Si el usuario hizo una pregunta, respóndela directo.`;

    const payload = {
      intent,
      askedText: askedText || "",
      prettyWhen: prettyWhen || "",
      optionsText: optionsText || "",
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
