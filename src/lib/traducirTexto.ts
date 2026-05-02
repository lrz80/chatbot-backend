import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Cache simple en memoria
const cache = new Map<string, string>();
const CACHE_VERSION = "v5_booking_flow_safe";

function normalizeTargetLanguage(idioma: string): string {
  const raw = String(idioma || "").trim().toLowerCase();

  if (!raw) return "es";

  if (raw.startsWith("en")) return "en";
  if (raw.startsWith("es")) return "es";
  if (raw.startsWith("pt")) return "pt";
  if (raw.startsWith("fr")) return "fr";
  if (raw.startsWith("it")) return "it";
  if (raw.startsWith("de")) return "de";

  return raw;
}

export async function traducirTexto(
  texto: string,
  idioma: string,
  mode: "default" | "catalog_label" = "default"
): Promise<string> {
  if (!texto) return "";

  const targetLanguage = normalizeTargetLanguage(idioma);

  const key = `${CACHE_VERSION}::${mode}::${texto}::${targetLanguage}`;
  if (cache.has(key)) return cache.get(key)!;

  const protectedTokens: string[] = [];

  const freeze = (match: string) => {
    const token = `__KEEP_${protectedTokens.length}__`;
    protectedTokens.push(match);
    return token;
  };

  let protectedText = texto;

  // ===============================
  // 🔒 PROTEGER PLACEHOLDERS
  // ===============================
  protectedText = protectedText.replace(/\{[a-zA-Z0-9_]+\}/g, freeze);

  // URLs
  protectedText = protectedText.replace(/https?:\/\/\S+/gi, freeze);

  // Emails
  protectedText = protectedText.replace(
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    freeze
  );

  // Dinero
  protectedText = protectedText.replace(
    /(\$\s*\d+(?:\.\d{1,2})?)|(\b\d+(?:\.\d{1,2})?\s*(?:usd|eur|gbp)\b)/gi,
    freeze
  );

  // Teléfonos
  protectedText = protectedText.replace(
    /\+?\d[\d\s\-().]{6,}\d/g,
    freeze
  );

  // Horas y números
  protectedText = protectedText.replace(
    /\b\d+(?:[.,]\d+)?(?:%|\/\d+)?(?::\d{2})?\b/g,
    freeze
  );

  const extraRules =
    mode === "catalog_label"
      ? `
REGLAS EXTRA DE CATÁLOGO:
- Traduce como nombres comerciales naturales de productos, servicios o planes.
- NO hagas traducción literal palabra por palabra si produce frases poco naturales.
- Conserva exactamente números, precios, símbolos y tokens __KEEP_X__.
`
      : `
REGLAS EXTRA DE FLUJO:
- Esto puede ser un mensaje de voz o interfaz conversacional.
- Mantén un tono natural y claro.
- Conserva exactamente placeholders, números, símbolos y tokens __KEEP_X__.
- NO agregues información nueva.
`;

  const prompt = `
Traduce el siguiente texto al idioma "${targetLanguage}".

REGLAS OBLIGATORIAS:
- NO cambies ningún número, símbolo ($), moneda, porcentaje ni tokens __KEEP_X__.
- NO traduzcas ni alteres placeholders como __KEEP_X__.
- NO reordenes líneas. Mantén EXACTAMENTE el mismo orden.
- NO cambies el formato de viñetas ni los saltos de línea.
- Solo traduce palabras.
${extraRules}

Texto:
${protectedText}
`.trim();

  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
  });

  let translated = response.output_text.trim();

  protectedTokens.forEach((val, i) => {
    const token = `__KEEP_${i}__`;
    translated = translated.split(token).join(val);
  });

  cache.set(key, translated);

  return translated;
}