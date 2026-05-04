// src/lib/voice/resolveVoiceLinkType.ts

import OpenAI from "openai";
import { LinkType } from "./types";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

const cache = new Map<string, LinkType>();
const CACHE_VERSION = "v1_voice_link_type";

function normalizeLocale(locale?: string | null): string {
  const raw = String(locale || "").trim().toLowerCase();
  if (!raw) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("pt")) return "pt";
  return "en";
}

export async function resolveVoiceLinkType(params: {
  utterance: string;
  locale?: string | null;
  fallback?: LinkType;
}): Promise<LinkType> {
  const utterance = String(params.utterance || "").trim();
  const locale = normalizeLocale(params.locale);
  const fallback = params.fallback || "reservar";

  if (!utterance) return fallback;

  const cacheKey = `${CACHE_VERSION}::${locale}::${utterance}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const prompt = `
Classify the link type requested in this voice utterance.

Return ONLY one of these exact values:
reservar
comprar
soporte
web

Rules:
- reservar = booking, appointment, reservation
- comprar = payment, checkout, buy, prices when clearly transactional
- soporte = help, support, representative, whatsapp support
- web = website, address, location, map, generic site info
- If unclear, return ${fallback}

Locale: ${locale}
Utterance:
${utterance}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  const raw = String(response.output_text || "").trim().toLowerCase();
  const resolved: LinkType =
    raw === "reservar" || raw === "comprar" || raw === "soporte" || raw === "web"
      ? raw
      : fallback;

  cache.set(cacheKey, resolved);
  return resolved;
}