//src/lib/voice/runtime/generateVoiceAssistantReply.ts
import OpenAI from "openai";
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

const OPENAI_TIMEOUT_MS = 3500;
const MAX_SYSTEM_PROMPT_CHARS = 700;
const MAX_USER_INPUT_CHARS = 500;
const MAX_COMPLETION_TOKENS = 50;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
});

function normalizeCompactText(value: string, maxChars: number): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function buildVoiceSystemPrompt({
  systemPrompt,
  brand,
}: {
  systemPrompt: string;
  brand: string;
}): string {
  const normalizedCustomPrompt = normalizeCompactText(
    systemPrompt,
    MAX_SYSTEM_PROMPT_CHARS
  );

  if (normalizedCustomPrompt) {
    return normalizedCustomPrompt;
  }

  return normalizeCompactText(
    `Eres Amy, asistente telefónica de ${brand}.
  Responde natural y breve.
  Máximo 2 frases.
  No inventes.
  No leas URLs en voz.`,
  MAX_SYSTEM_PROMPT_CHARS
  );
}

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

  const normalizedUserInput = normalizeCompactText(
    effectiveUserInput,
    MAX_USER_INPUT_CHARS
  );

  if (!normalizedUserInput) {
    return { respuesta };
  }

  const finalSystemPrompt = buildVoiceSystemPrompt({
    systemPrompt,
    brand,
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const completion = await openai.chat.completions.create(
      {
        model: "gpt-4o-mini",
        temperature: 0,
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: [
          {
            role: "system",
            content: finalSystemPrompt,
          },
          {
            role: "user",
            content: normalizedUserInput,
          },
        ],
      },
      { signal: controller.signal as any }
    );

    respuesta = completion.choices[0]?.message?.content?.trim() || respuesta;

    const usage = (completion as any).usage ?? {};
    const totalTokens =
      typeof usage.total_tokens === "number"
        ? usage.total_tokens
        : (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);

    const cicloInicio = cycleStartForNow(membershipStart ?? new Date());

    if (totalTokens > 0) {
      void pool
        .query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, $2, $3::date, $4)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenantId, channelKey, cicloInicio, totalTokens]
        )
        .catch((error) => {
          console.warn("[VOICE][OPENAI_USAGE_LOG_FAILED]", {
            tenantId,
            channelKey,
            error: error?.message || error,
          });
        });
    }

    console.log("[VOICE][OPENAI_LATENCY_MS]", {
      tenantId,
      channelKey,
      elapsedMs: Date.now() - startedAt,
      promptChars: finalSystemPrompt.length,
      userChars: normalizedUserInput.length,
      totalTokens,
    });
  } catch (e: any) {
    console.warn("[VOICE][OPENAI_FALLBACK]", {
      tenantId,
      channelKey,
      elapsedMs: Date.now() - startedAt,
      error: e?.message || e,
    });
  } finally {
    clearTimeout(timer);
  }

  return { respuesta };
}