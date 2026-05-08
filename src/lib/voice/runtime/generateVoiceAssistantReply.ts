//src/lib/voice/runtime/generateVoiceAssistantReply.ts
import pool from "../../db";
import { cycleStartForNow } from "../../../utils/billingCycle";
import { renderVoiceReply } from "../renderVoiceReply";
import type { VoiceLocale } from "../types";

type GenerateVoiceAssistantReplyParams = {
  tenantId: string;
  membershipStart: string | Date | null;
  channelKey: string;
  currentLocale: VoiceLocale;
  effectiveUserInput: string;
  systemPrompt: string;
  brand: string;
};

type GenerateVoiceAssistantReplyResult = {
  respuesta: string;
};

export async function generateVoiceAssistantReply(
  params: GenerateVoiceAssistantReplyParams
): Promise<GenerateVoiceAssistantReplyResult> {
  const {
    tenantId,
    membershipStart,
    channelKey,
    currentLocale,
    effectiveUserInput,
    systemPrompt,
    brand,
  } = params;

  let respuesta = renderVoiceReply("fallback_not_understood", {
    locale: currentLocale,
  });

  try {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const completion = await openai.chat.completions.create(
      {
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              systemPrompt ||
              `Eres Amy, asistente telefónica del negocio ${brand}. 
REGLAS:
- NO menciones precios ni montos al hablar, nunca inventes números.
- Si el usuario pregunta por precios, horarios, ubicación o pagos, ofrece enviar un SMS con el enlace correspondiente (no los leas en voz).
- Jamás leas URL en voz.
- Responde breve y natural.`,
          },
          { role: "user", content: effectiveUserInput },
        ],
      },
      { signal: controller.signal as any }
    );

    clearTimeout(timer);

    respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

    const usage = (completion as any).usage ?? {};
    const totalTokens =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

    const cicloInicio = cycleStartForNow(membershipStart ?? new Date());

    if (totalTokens > 0) {
      await pool.query(
        `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
         VALUES ($1, $2, $3::date, $4)
         ON CONFLICT (tenant_id, canal, mes)
         DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
        [tenantId, channelKey, cicloInicio, totalTokens]
      );
    }
  } catch (e) {
    console.warn("[VOICE][OPENAI_FALLBACK]", e);
  }

  return { respuesta };
}