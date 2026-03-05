// backend/src/lib/traducirMensaje.ts
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

export async function traducirMensaje(
  texto: string,
  idiomaObjetivo: string
): Promise<string> {
  try {
    const input = String(texto || "");
    if (!input.trim()) return input;

    // 1) Congelar tokens que NO se pueden cambiar (precios, números, urls, emails)
    const frozen: string[] = [];
    const freeze = (match: string) => {
      const key = `__KEEP_${frozen.length}__`;
      frozen.push(match);
      return key;
    };

    // URLs
    let protectedText = input.replace(/https?:\/\/\S+/gi, freeze);

    // Emails
    protectedText = protectedText.replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      freeze
    );

    // Dinero: $59.99, $ 59.99, 59.99 USD, 149.99usd, etc.
    protectedText = protectedText.replace(
      /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(?:usd|eur|gbp)\b)/gi,
      freeze
    );

    // Números con decimales / porcentajes / cantidades (conserva EXACTO)
    // (Incluye 59.99, 7 días, 24/7, 3 meses, 10:30, 2026-03-05, etc.)
    protectedText = protectedText.replace(
      /\b\d+(?:[.,]\d+)?(?:%|\/\d+)?\b/g,
      freeze
    );

    // 2) Prompt con reglas duras: NO tocar placeholders, NO tocar formato
    const system = [
      "Eres un traductor profesional.",
      "REGLAS OBLIGATORIAS:",
      `- Traduce al idioma objetivo: "${idiomaObjetivo}".`,
      "- NO cambies NINGÚN número, monto, moneda, porcentaje, fecha, hora, ni unidades.",
      "- NO cambies NINGÚN link (URL) ni email.",
      "- Los placeholders con forma __KEEP_N__ deben permanecer EXACTAMENTE iguales.",
      "- No redondees, no reformatees, no añadas ni quites decimales.",
      "- Devuelve SOLO el texto traducido, sin comentarios.",
    ].join("\n");

    const user = `Texto:\n${protectedText}`;

    const response = await openai.chat.completions.create({
      // si quieres dejar gpt-4, ok. Yo bajaría a gpt-4.1-mini para traducción,
      // pero NO es requisito para corregir el bug.
      model: "gpt-4",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0, // clave: menos “creatividad” = menos inventos/redondeos
    });

    let out = response.choices[0]?.message?.content?.trim() || input;

    // 3) Restaurar tokens congelados
    for (let i = 0; i < frozen.length; i++) {
      const key = `__KEEP_${i}__`;
      out = out.split(key).join(frozen[i]);
    }

    return out || input;
  } catch (err) {
    console.error("❌ Error traduciendo mensaje:", err);
    return texto;
  }
}