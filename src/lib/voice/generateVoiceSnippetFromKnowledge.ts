// src/lib/voice/generateVoiceSnippetFromKnowledge.ts

import { SupportedVoiceLocale } from "./resolveVoiceLanguage";

export type VoiceSnippetTopic =
  | "precios"
  | "horarios"
  | "ubicacion"
  | "pagos";

type GenerateVoiceSnippetFromKnowledgeParams = {
  topic: VoiceSnippetTopic;
  cfg: {
    system_prompt?: string | null;
    info_clave?: string | null;
  };
  locale: SupportedVoiceLocale;
  brand: string;
};

export async function generateVoiceSnippetFromKnowledge({
  topic,
  cfg,
  locale,
  brand,
}: GenerateVoiceSnippetFromKnowledgeParams): Promise<string> {
  const { default: OpenAI } = await import("openai");

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  const systemPrompt = (cfg.system_prompt || "").toString().trim();
  const keyInfo = (cfg.info_clave || "").toString().trim();

  const system = locale.startsWith("es")
    ? `
Eres Amy, asistente del negocio ${brand}.
Usa EXCLUSIVAMENTE la información en estas dos fuentes:

1) SYSTEM_PROMPT DEL NEGOCIO:
${systemPrompt}

2) INFO_CLAVE DEL NEGOCIO:
${keyInfo}

REGLAS DE RESPUESTA:
- Devuelve 1-2 frases máximo, aptas para locución telefónica.
- No incluyas URLs ni digas que enviarás un link aquí.
- No inventes datos.
- Para horarios, formatea horas de forma natural.
- Para precios, solo menciona montos si aparecen literalmente.
- Mantén el tono breve, claro y natural.
`.trim()
    : `
You are Amy, the assistant for ${brand}.
Use ONLY the information from these two sources:

1) BUSINESS SYSTEM PROMPT:
${systemPrompt}

2) BUSINESS KEY INFO:
${keyInfo}

RESPONSE RULES:
- Reply in 1-2 sentences maximum, suitable for phone speech.
- Do not include URLs or say you will send a link here.
- Do not invent information.
- For hours, format time naturally.
- For prices, mention amounts only if they appear literally.
- Keep the tone brief, clear, and natural.
`.trim();

  const user = locale.startsWith("es")
    ? `Responde únicamente en español. Dame un breve resumen sobre ${topic} en máximo 2 frases, usando solo lo provisto.`
    : `Respond only in English. Give me a short summary about ${topic} in at most 2 sentences, using only the provided information.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = (completion.choices[0]?.message?.content || "").trim();

  if (text) {
    return text;
  }

  return locale.startsWith("es")
    ? "No tengo ese dato exacto aquí."
    : "I don’t have that exact detail here.";
}