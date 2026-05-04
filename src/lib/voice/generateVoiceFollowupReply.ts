// src/lib/voice/generateVoiceFollowupReply.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export type VoiceFollowupStep =
  | "service"
  | "datetime"
  | "confirm"
  | "fallback";

type GenerateVoiceFollowupReplyParams = {
  userInput: string;
  step: VoiceFollowupStep;
  locale: SupportedVoiceLocale | string;
  cfg: {
    system_prompt?: string | null;
  };
  bookingData?: {
    service?: string;
    datetime?: string;
  };
};

function buildStepInstruction(
  step: VoiceFollowupStep,
  locale: SupportedVoiceLocale | string,
  bookingData?: {
    service?: string;
    datetime?: string;
  }
): string {
  const isSpanish = (locale || "").toLowerCase().startsWith("es");

  if (step === "service") {
    return isSpanish
      ? "El cliente quiere una cita. Pregunta qué servicio desea de forma natural."
      : "The client wants to book. Ask what service they want.";
  }

  if (step === "datetime") {
    return isSpanish
      ? "El cliente ya dijo el servicio. Pide día y hora de forma natural."
      : "Ask for date and time.";
  }

  if (step === "confirm") {
    return isSpanish
      ? `Confirma la cita usando estos datos:
Servicio: ${bookingData?.service || "no especificado"}
Fecha/hora: ${bookingData?.datetime || "no especificada"}

Debe sonar natural, corto y pedir confirmación.`
      : `Confirm appointment using:
Service: ${bookingData?.service || "not specified"}
Date/time: ${bookingData?.datetime || "not specified"}

Keep it natural and ask for confirmation.`;
  }

  return isSpanish
    ? "El cliente dijo que no al SMS. Continúa la conversación de forma natural preguntando cómo puedes ayudar."
    : "Client declined SMS. Continue conversation naturally.";
}

export async function generateVoiceFollowupReply({
  userInput,
  step,
  locale,
  cfg,
  bookingData,
}: GenerateVoiceFollowupReplyParams): Promise<string> {
  const { default: OpenAI } = await import("openai");

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const system = (cfg.system_prompt || "").toString().trim();
  const stepInstruction = buildStepInstruction(step, locale, bookingData);

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.3,
    messages: [
      {
        role: "system",
        content: system,
      },
      {
        role: "user",
        content: `
Cliente dijo: "${userInput}"
Paso actual: ${stepInstruction}
`.trim(),
      },
    ],
  });

  return completion.choices[0]?.message?.content?.trim() || "";
}