// src/lib/voice/resolveVoiceMenuSelection.ts

import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const cache = new Map<string, "1" | "2" | "3" | "4" | undefined>();
const CACHE_VERSION = "v1_voice_menu_selection";

function normalizeLocale(locale?: string | null): string {
  const raw = String(locale || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("pt")) return "pt";
  return "en";
}

export async function resolveVoiceMenuSelection(params: {
  utterance: string;
  locale?: string | null;
}): Promise<"1" | "2" | "3" | "4" | undefined> {
  const utterance = String(params.utterance || "").trim();
  const locale = normalizeLocale(params.locale);

  if (!utterance) return undefined;

  const cacheKey = `${CACHE_VERSION}::${locale}::${utterance}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const prompt = `
Map this voice utterance to a menu option.

Return ONLY one of:
1
2
3
4
none

Menu semantics:
1 = prices / payment / buy
2 = hours / schedule
3 = address / location / map
4 = representative / human / agent / operator

If it does not clearly match one option, return none.

Locale: ${locale}
Utterance:
${utterance}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const raw = String(response.output_text || "").trim().toLowerCase();
  const resolved =
    raw === "1" || raw === "2" || raw === "3" || raw === "4"
      ? (raw as "1" | "2" | "3" | "4")
      : undefined;

  cache.set(cacheKey, resolved);
  return resolved;
}