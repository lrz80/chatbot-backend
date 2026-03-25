// src/lib/fastpath/llm/answerCatalogQuestionLLM.ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type CatalogQuestionLlmMode =
  | "grounded_frame_only"
  | "grounded_catalog_sales";

export async function answerCatalogQuestionLLM(params: {
  idiomaDestino: "es" | "en";
  canonicalReply: string;
  userInput: string;
  mode?: CatalogQuestionLlmMode;
  maxIntroLines?: number;
  maxClosingLines?: number;
}): Promise<string | null> {
  const {
    idiomaDestino,
    canonicalReply,
    userInput,
    mode = "grounded_frame_only",
    maxIntroLines = 1,
    maxClosingLines = 1,
  } = params;

  const canonical = String(canonicalReply || "").trim();
  const userMsgRaw = String(userInput || "").trim();

  if (!canonical) return null;

  const systemMsg = buildSystemMsg({
    idiomaDestino,
    mode,
    maxIntroLines,
    maxClosingLines,
  });

  const userMsg = buildUserMsg({
    idiomaDestino,
    canonicalReply: canonical,
    userInput: userMsgRaw,
  });

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.35,
  });

  const reply = String(completion.choices[0]?.message?.content || "").trim();
  if (!reply) return null;

  const preservesCanonicalBullets = preservesCanonicalCatalogBullets(
    canonical,
    reply
  );

  if (!preservesCanonicalBullets) {
    return null;
  }

  return reply;
}

function buildSystemMsg(params: {
  idiomaDestino: "es" | "en";
  mode: CatalogQuestionLlmMode;
  maxIntroLines: number;
  maxClosingLines: number;
}): string {
  const { idiomaDestino, mode, maxIntroLines, maxClosingLines } = params;

  const langInstruction =
    idiomaDestino === "es"
      ? "Responde solo en español."
      : "Reply only in English.";

  const salesInstruction =
    mode === "grounded_catalog_sales"
      ? idiomaDestino === "es"
        ? "Tu objetivo es ayudar a vender con una respuesta clara, breve y natural."
        : "Your goal is to help sell with a clear, brief, natural reply."
      : idiomaDestino === "es"
      ? "Tu objetivo es mejorar el framing de la respuesta sin alterar el contenido resuelto."
      : "Your goal is to improve the framing without altering the resolved content.";

  const introInstruction =
    idiomaDestino === "es"
      ? `Puedes agregar un intro corto de máximo ${maxIntroLines} línea(s).`
      : `You may add a short intro of at most ${maxIntroLines} line(s).`;

  const closingInstruction =
    idiomaDestino === "es"
      ? `Puedes agregar un cierre/CTA corto de máximo ${maxClosingLines} línea(s).`
      : `You may add a short closing/CTA of at most ${maxClosingLines} line(s).`;

  const bulletInstruction =
    idiomaDestino === "es"
      ? [
          "Debes conservar EXACTAMENTE el cuerpo canónico del catálogo.",
          "No cambies nombres de planes, servicios o variantes.",
          "No cambies montos, símbolos de moneda, ni el orden.",
          "No elimines ni agregues bullets del cuerpo canónico.",
          "No resumas ni reescribas los bullets.",
          "No conviertas bullets a párrafos.",
          "Puedes envolver el cuerpo con un intro y/o un cierre breve, pero el bloque canónico debe quedar intacto.",
        ].join("\n")
      : [
          "You must preserve the catalog canonical body EXACTLY.",
          "Do not change plan, service, or variant names.",
          "Do not change amounts, currency symbols, or order.",
          "Do not remove or add bullets from the canonical body.",
          "Do not summarize or rewrite the bullets.",
          "Do not turn bullets into paragraphs.",
          "You may wrap the body with a brief intro and/or closing, but the canonical block must remain intact.",
        ].join("\n");

  const formatInstruction =
    idiomaDestino === "es"
      ? [
          "Formato requerido:",
          "1. intro opcional breve",
          "2. bloque canónico EXACTO",
          "3. cierre opcional breve",
        ].join("\n")
      : [
          "Required format:",
          "1. optional brief intro",
          "2. EXACT canonical block",
          "3. optional brief closing",
        ].join("\n");

  return [
    langInstruction,
    salesInstruction,
    introInstruction,
    closingInstruction,
    bulletInstruction,
    formatInstruction,
  ].join("\n\n");
}

function buildUserMsg(params: {
  idiomaDestino: "es" | "en";
  canonicalReply: string;
  userInput: string;
}): string {
  const { idiomaDestino, canonicalReply, userInput } = params;

  if (idiomaDestino === "es") {
    return [
      `Mensaje del cliente: ${userInput || "(vacío)"}`,
      "",
      "Cuerpo canónico resuelto desde DB:",
      canonicalReply,
      "",
      "Devuélveme la respuesta final lista para enviar, mejorando solo el framing comercial sin alterar el cuerpo canónico.",
    ].join("\n");
  }

  return [
    `Customer message: ${userInput || "(empty)"}`,
    "",
    "Canonical DB-resolved body:",
    canonicalReply,
    "",
    "Return the final reply ready to send, improving only the sales framing without altering the canonical body.",
  ].join("\n");
}

function normalizeCatalogLine(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractBulletLines(text: string): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const first = line.charAt(0);
      return first === "•" || first === "-" || first === "*";
    });
}

function preservesCanonicalCatalogBullets(
  canonicalReply: string,
  modelReply: string
): boolean {
  const canonicalBullets = extractBulletLines(canonicalReply).map(
    normalizeCatalogLine
  );
  const modelBullets = extractBulletLines(modelReply).map(normalizeCatalogLine);

  if (!canonicalBullets.length || !modelBullets.length) return false;
  if (canonicalBullets.length !== modelBullets.length) return false;

  for (let i = 0; i < canonicalBullets.length; i += 1) {
    if (canonicalBullets[i] !== modelBullets[i]) {
      return false;
    }
  }

  return true;
}