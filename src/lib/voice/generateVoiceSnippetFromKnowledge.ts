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

function topicInstruction(topic: VoiceSnippetTopic, locale: SupportedVoiceLocale): string {
  if (locale.startsWith("es")) {
    switch (topic) {
      case "precios":
        return "Extrae solamente la información relacionada con precios, costos, tarifas o condiciones de precio.";
      case "horarios":
        return "Extrae solamente la información relacionada con horarios, días de atención, disponibilidad o agenda.";
      case "ubicacion":
        return "Extrae solamente la información relacionada con ubicación, dirección, zona, ciudad o instrucciones para llegar.";
      case "pagos":
        return "Extrae solamente la información relacionada con métodos de pago aceptados.";
    }
  }

  switch (topic) {
    case "precios":
      return "Extract only information related to prices, costs, rates, or pricing conditions.";
    case "horarios":
      return "Extract only information related to hours, business days, availability, or schedule.";
    case "ubicacion":
      return "Extract only information related to location, address, area, city, or directions.";
    case "pagos":
      return "Extract only information related to accepted payment methods.";
  }
}

function fallbackText(topic: VoiceSnippetTopic, locale: SupportedVoiceLocale): string {
  if (locale.startsWith("es")) {
    switch (topic) {
      case "precios":
        return "No tengo los precios exactos configurados en este momento.";
      case "horarios":
        return "No tengo los horarios exactos configurados en este momento.";
      case "ubicacion":
        return "No tengo la ubicación exacta configurada en este momento.";
      case "pagos":
        return "No tengo los métodos de pago exactos configurados en este momento.";
    }
  }

  switch (topic) {
    case "precios":
      return "I do not have the exact pricing configured right now.";
    case "horarios":
      return "I do not have the exact hours configured right now.";
    case "ubicacion":
      return "I do not have the exact location configured right now.";
    case "pagos":
      return "I do not have the exact payment methods configured right now.";
  }
}

function cleanKnowledge(value: string): string {
  return (value || "")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function stripUnsupportedOutput(value: string): string {
  return (value || "")
    .replace(/\[\[.*?\]\]/g, "")
    .replace(/\bhttps?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function generateVoiceSnippetFromKnowledge({
  topic,
  cfg,
  locale,
  brand,
}: GenerateVoiceSnippetFromKnowledgeParams): Promise<string> {
  const systemPrompt = cleanKnowledge((cfg.system_prompt || "").toString());
  const keyInfo = cleanKnowledge((cfg.info_clave || "").toString());

  const knowledge = [systemPrompt, keyInfo].filter(Boolean).join("\n\n");

  if (!knowledge) {
    return fallbackText(topic, locale);
  }

  const { default: OpenAI } = await import("openai");

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
  });

  const instruction = topicInstruction(topic, locale);

  const system = locale.startsWith("es")
    ? `
Eres Amy, asistente telefónica del negocio ${brand}.

TAREA:
${instruction}

FUENTE ÚNICA DE VERDAD:
Usa solamente el contenido provisto por el negocio.

REGLAS:
- Responde en español.
- Devuelve máximo 2 frases.
- No inventes datos.
- No agregues información externa.
- No incluyas URLs.
- No digas que enviarás SMS ni links.
- Si el dato no aparece en la fuente, responde exactamente: "${fallbackText(topic, locale)}"
- Para direcciones, teléfonos, nombres de calles, códigos postales, precios y horarios: copia los datos exactamente como aparecen en la fuente. No los reescribas, no los traduzcas y no los conviertas en palabras.
`.trim()
    : `
You are Amy, the phone assistant for ${brand}.

TASK:
${instruction}

ONLY SOURCE OF TRUTH:
Use only the business-provided content.

RULES:
- Reply in English.
- Return at most 2 sentences.
- Do not invent facts.
- Do not add external information.
- Do not include URLs.
- Do not say you will send SMS or links.
- If the detail does not appear in the source, reply exactly: "${fallbackText(topic, locale)}"
- For addresses, phone numbers, street names, zip codes, prices, and hours: copy the facts exactly as they appear in the source. Do not rewrite, translate, or spell them out.
`.trim();

  const user = locale.startsWith("es")
    ? `
Contenido del negocio:
${knowledge}

Extrae la respuesta telefónica breve para el tema: ${topic}.
`.trim()
    : `
Business content:
${knowledge}

Extract the short phone answer for topic: ${topic}.
`.trim();

  const fallback = fallbackText(topic, locale);

  const completion = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    3500,
    null as any
  );

  const raw = completion?.choices?.[0]?.message?.content?.trim() || "";

  const cleaned = stripUnsupportedOutput(raw);

  return cleaned || fallback;
}