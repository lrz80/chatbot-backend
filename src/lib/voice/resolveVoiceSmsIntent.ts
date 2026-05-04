// src/lib/voice/resolveVoiceSmsIntent.ts

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const cache = new Map<string, ResolveVoiceSmsIntentResult>();
const CACHE_VERSION = "v1_voice_sms_intent";

export type ResolveVoiceSmsIntentResult = {
  userRequestedSms: boolean;
  assistantPromisedSms: boolean;
};

function normalizeLocale(locale?: string | null): string {
  const raw = String(locale || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("pt")) return "pt";
  return "en";
}

export async function resolveVoiceSmsIntent(params: {
  userUtterance?: string | null;
  assistantUtterance?: string | null;
  locale?: string | null;
}): Promise<ResolveVoiceSmsIntentResult> {
  const userUtterance = String(params.userUtterance || "").trim();
  const assistantUtterance = String(params.assistantUtterance || "").trim();
  const locale = normalizeLocale(params.locale);

  const cacheKey = `${CACHE_VERSION}::${locale}::${userUtterance}::${assistantUtterance}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prompt = `
Classify SMS intent in a phone conversation.

Return ONLY strict JSON with this exact shape:
{"userRequestedSms":true|false,"assistantPromisedSms":true|false}

Rules:
- userRequestedSms = true only if the user is clearly asking to receive something by SMS/text/message.
- assistantPromisedSms = true only if the assistant message clearly says it will send something by SMS/text/message.
- Do not infer from vague wording.
- Locale: ${locale}

User utterance:
${userUtterance || "(empty)"}

Assistant utterance:
${assistantUtterance || "(empty)"}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let parsed: ResolveVoiceSmsIntentResult = {
    userRequestedSms: false,
    assistantPromisedSms: false,
  };

  try {
    const obj = JSON.parse(response.output_text.trim());
    parsed = {
      userRequestedSms: !!obj?.userRequestedSms,
      assistantPromisedSms: !!obj?.assistantPromisedSms,
    };
  } catch {
    parsed = {
      userRequestedSms: false,
      assistantPromisedSms: false,
    };
  }

  cache.set(cacheKey, parsed);
  return parsed;
}