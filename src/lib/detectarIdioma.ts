// src/lib/detectarIdioma.ts
import OpenAI from "openai";

// ✅ Mensajes que NO deben cambiar idioma (muy cortos / genéricos)
function esAmbiguo(texto: string) {
  const t = String(texto || "").trim().toLowerCase();
  if (!t) return true;

  // emojis o confirmaciones ultra-cortas
  if (t.length <= 2) return true;

  // ✅ NO incluyas hello/hola aquí (eso sí define idioma)
  if (/^(ok|okay|kk|👍|yes|no|si|sí|y|n)$/i.test(t)) return true;

  return false;
}

/**
 * Pre-detector local (rápido y estable).
 * Devuelve: "es" | "en" | "pt" | null (null => usar OpenAI)
 */
function detectarIdiomaLocal(input: string): "es" | "en" | "pt" | null {
  const t = String(input || "").trim().toLowerCase();
  if (!t) return null;

  // Señales fuertes de español (caracteres)
  if (/[ñáéíóúü¿¡]/.test(t)) return "es";

  // Señales fuertes de portugués (caracteres)
  if (/[ãõç]/.test(t)) return "pt";

  // Palabras comunes ES
  if (/\b(hola|buenas|precio|informacion|información|clase|clases|agendar|reservar|horario|cita)\b/.test(t)) {
    return "es";
  }

  // Palabras comunes EN
  if (/\b(hello|hi|hey|please|info|information|class|classes|schedule|book|booking|i need|i want)\b/.test(t)) {
    return "en";
  }

  // Palabras comunes PT
  if (/\b(ol[aá]|por favor|informa(c|ç)[aã]o|agendar|marcar|hor[aá]rio)\b/.test(t)) {
    return "pt";
  }

  return null;
}

/**
 * Detector final:
 * - Si es ambiguo => "und"
 * - Si local decide => "es"|"en"|"pt"
 * - Si no, OpenAI fallback
 */
export async function detectarIdioma(texto: string): Promise<"es" | "en" | "pt" | "und"> {
  if (esAmbiguo(texto)) return "und";

  const local = detectarIdiomaLocal(texto);
  if (local) return local;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

  const respuesta = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content:
          `Detecta el idioma de este mensaje y responde SOLO con: es, en, o pt.\n\nMensaje: "${texto}"`,
      },
    ],
    temperature: 0,
  });

  const idioma = respuesta.choices[0]?.message?.content?.trim().toLowerCase();

  if (idioma === "es" || idioma === "en" || idioma === "pt") return idioma;

  // Si OpenAI responde basura, NO fuerces "es" aquí.
  // Devuelve "und" para que el webhook use el sticky anterior.
  return "und";
}
