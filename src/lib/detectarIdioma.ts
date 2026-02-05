import OpenAI from "openai";

export async function detectarIdioma(texto: string): Promise<"es" | "en"> {
  const t = String(texto || "").trim().toLowerCase();

  // Mensajes demasiado cortos o ambiguos → NO CAMBIAN idioma
  if (t.length <= 2 || /^(ok|okay|k|👍|yes|no|si|sí)$/i.test(t)) {
    return "es";
  }

  // Saludos claros: sí determinan idioma
  if (/^(hola|buenas|buenos\s+d[ií]as|buenas\s+tardes|buenas\s+noches)$/i.test(t)) return "es";
  if (/^(hello|hi|hey)$/i.test(t)) return "en";

  // Heurísticas rápidas
  if (/[ñáéíóúü¿¡]/.test(t)) return "es";
  if (/\b(hola|buenas|precio|información|agendar|reservar)\b/.test(t)) return "es";
  if (/\b(hello|hi|please|info|information|class|schedule|book)\b/.test(t)) return "en";

  // OpenAI (solo ES o EN)
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  const res = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      {
        role: "user",
        content: `Detecta si este texto está en español o inglés. Responde solo "es" o "en": "${texto}"`,
      },
    ],
    temperature: 0,
  });

  const out = res.choices[0]?.message?.content?.trim().toLowerCase();

  return out === "en" ? "en" : "es";
}
