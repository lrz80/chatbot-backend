import OpenAI from "openai";

export type Lang = "es" | "en";

export type DetectIdiomaResult = {
  lang: Lang | null;
  confidence: number;
  source: "heuristic" | "openai" | "none";
};

export async function detectarIdioma(texto: string): Promise<DetectIdiomaResult> {
  const raw = String(texto || "").trim();
  const t = raw.toLowerCase();

  if (!t) {
    return { lang: null, confidence: 0, source: "none" };
  }

  // Heurísticas mínimas, no política conversacional
  if (/[ñáéíóúü¿¡]/.test(t)) {
    return { lang: "es", confidence: 0.95, source: "heuristic" };
  }

  if (/\b(the|and|with|from|this|that|please|thank)\b/.test(t)) {
    return { lang: "en", confidence: 0.85, source: "heuristic" };
  }

  if (/\b(el|la|los|las|con|para|por|gracias|hola)\b/.test(t)) {
    return { lang: "es", confidence: 0.85, source: "heuristic" };
  }

  if (t.length < 4) {
    return { lang: null, confidence: 0, source: "none" };
  }

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: "Detect the language of the text. Reply only 'es' or 'en'." },
      { role: "user", content: raw },
    ],
  });

  const out = res.choices[0]?.message?.content?.trim().toLowerCase();

  if (out === "es" || out === "en") {
    return { lang: out, confidence: 0.9, source: "openai" };
  }

  return { lang: null, confidence: 0, source: "none" };
}