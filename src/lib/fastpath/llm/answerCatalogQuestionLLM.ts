// src/lib/fastpath/llm/answerCatalogQuestionLLM.ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type CatalogQuestionLlmMode =
  | "grounded_frame_only"
  | "grounded_catalog_sales";

export type CatalogRenderIntent =
  | "catalog_compare"
  | "catalog_detail"
  | "catalog_list";

export type CatalogComparisonItem = {
  id: string;
  name: string;
  description: string;
  minPrice: number | null;
  maxPrice: number | null;
};

export async function answerCatalogQuestionLLM(params: {
  idiomaDestino: "es" | "en";
  canonicalReply: string;
  userInput: string;
  mode?: CatalogQuestionLlmMode;
  renderIntent?: CatalogRenderIntent;
  comparisonItems?: CatalogComparisonItem[];
  maxIntroLines?: number;
  maxClosingLines?: number;
}): Promise<string | null> {
  const {
    idiomaDestino,
    canonicalReply,
    userInput,
    mode = "grounded_frame_only",
    renderIntent = "catalog_detail",
    comparisonItems = [],
    maxIntroLines = 1,
    maxClosingLines = 1,
  } = params;

  const canonical = String(canonicalReply || "").trim();
  const userMsgRaw = String(userInput || "").trim();

  if (!canonical) return null;

  const systemMsg = buildSystemMsg({
    idiomaDestino,
    mode,
    renderIntent,
    maxIntroLines,
    maxClosingLines,
  });

  const userMsg = buildUserMsg({
    idiomaDestino,
    canonicalReply: canonical,
    userInput: userMsgRaw,
    renderIntent,
    comparisonItems,
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

  if (renderIntent === "catalog_compare") {
    return reply;
  }

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
  renderIntent: CatalogRenderIntent;
  maxIntroLines: number;
  maxClosingLines: number;
}): string {
  const {
    idiomaDestino,
    mode,
    renderIntent,
    maxIntroLines,
    maxClosingLines,
  } = params;

  const langInstruction =
    idiomaDestino === "es"
      ? "Responde solo en español."
      : "Reply only in English.";

  const salesInstruction =
    mode === "grounded_catalog_sales"
      ? idiomaDestino === "es"
        ? "Tu objetivo es ayudar a vender con una respuesta clara, breve, natural y útil."
        : "Your goal is to help sell with a clear, brief, natural, useful reply."
      : idiomaDestino === "es"
      ? "Tu objetivo es mejorar el framing de la respuesta sin alterar el contenido resuelto."
      : "Your goal is to improve the framing without altering the resolved content.";

  const introInstruction =
    idiomaDestino === "es"
      ? `Puedes agregar un intro corto de máximo ${maxIntroLines} línea(s), pero solo si aporta valor real.`
      : `You may add a short intro of at most ${maxIntroLines} line(s), but only if it adds real value.`;

  const closingInstruction =
    idiomaDestino === "es"
      ? `Puedes agregar un cierre/CTA corto de máximo ${maxClosingLines} línea(s), pero solo si ayuda a avanzar de forma natural.`
      : `You may add a short closing/CTA of at most ${maxClosingLines} line(s), but only if it helps move the conversation forward naturally.`;

  const bulletInstruction =
    renderIntent === "catalog_compare"
      ? idiomaDestino === "es"
        ? [
            "Estás respondiendo una comparación entre opciones de catálogo resueltas desde DB.",
            "Debes contrastar las opciones entre sí; no describirlas como fichas separadas.",
            "No inventes atributos, beneficios, diferencias, precios, descuentos, disponibilidad ni includes.",
            "Si faltan datos diferenciales, dilo con claridad sin inventar.",
            "Debes responder de forma útil para venta consultiva, no como catálogo pasivo.",
            "Después de explicar la diferencia principal, recomienda cuál conviene según el objetivo o uso esperado, pero solo usando los datos resueltos.",
            "Cierra con una sola pregunta breve que ayude a avanzar la conversación de venta.",
            "No cierres en seco.",
            ].join("\n")
        : [
            "You are answering a comparison between catalog options resolved from DB.",
            "You must contrast the options against each other; do not describe them as separate cards.",
            "Do not invent attributes, benefits, differences, prices, discounts, availability, or included items.",
            "If differential data is missing, say so clearly without inventing.",
            "You must answer in a consultative sales style, not as a passive catalog.",
            "After explaining the main difference, recommend which option fits better depending on the user's likely goal or use case, using only resolved data.",
            "End with one brief forward-moving sales question.",
            "Do not end abruptly.",
          ].join("\n")
      : idiomaDestino === "es"
      ? [
          "Debes conservar EXACTAMENTE el cuerpo canónico del catálogo.",
          "No cambies nombres de planes, servicios o variantes.",
          "No cambies montos, símbolos de moneda, horarios, ubicación, disponibilidad ni el orden.",
          "No elimines ni agregues bullets del cuerpo canónico.",
          "No resumas ni reescribas los bullets.",
          "No conviertas bullets a párrafos.",
          "Puedes envolver el cuerpo con un intro y/o un cierre breve, pero el bloque canónico debe quedar intacto.",
        ].join("\n")
      : [
          "You must preserve the catalog canonical body EXACTLY.",
          "Do not change plan, service, or variant names.",
          "Do not change amounts, currency symbols, schedules, location, availability, or order.",
          "Do not remove or add bullets from the canonical body.",
          "Do not summarize or rewrite the bullets.",
          "Do not turn bullets into paragraphs.",
          "You may wrap the body with a brief intro and/or closing, but the canonical block must remain intact.",
        ].join("\n");

  const framingRules =
    idiomaDestino === "es"
      ? [
          "No dupliques el framing.",
          "No uses dos introducciones seguidas.",
          "No repitas fórmulas como 'Con gusto te comparto', 'Claro, aquí tienes', 'Aquí tienes la información' en la misma respuesta.",
          "No agregues un CTA genérico si la respuesta ya resuelve bien la pregunta.",
          "Si la consulta es de horarios, ubicación o disponibilidad general, prioriza claridad y brevedad sobre entusiasmo comercial.",
          "Si agregas intro, usa solo una línea.",
          "Si agregas cierre, usa solo una línea.",
        ].join("\n")
      : [
          "Do not duplicate framing.",
          "Do not use two introductions in the same reply.",
          "Do not repeat formulas like 'Of course', 'Here are the details', or similar in the same reply.",
          "Do not add a generic CTA if the reply already fully answers the question.",
          "For general schedule, location, or availability questions, prioritize clarity and brevity over sales enthusiasm.",
          "If you add an intro, use only one line.",
          "If you add a closing, use only one line.",
        ].join("\n");

  const formatInstruction =
    renderIntent === "catalog_compare"
      ? idiomaDestino === "es"
        ? [
            "Formato requerido:",
            "1. intro opcional breve",
            "2. diferencia principal entre las opciones",
            "3. recomendación breve de cuál conviene según el uso u objetivo",
            "4. pregunta final breve para avanzar la venta",
            ].join("\n")
        : [
            "Required format:",
            "1. optional brief intro",
            "2. main difference between the options",
            "3. brief recommendation on which one fits better depending on use case or goal",
            "4. brief final question to move the sale forward",
          ].join("\n")
      : idiomaDestino === "es"
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
    framingRules,
    formatInstruction,
  ].join("\n\n");
}

function buildUserMsg(params: {
  idiomaDestino: "es" | "en";
  canonicalReply: string;
  userInput: string;
  renderIntent: CatalogRenderIntent;
  comparisonItems: CatalogComparisonItem[];
}): string {
  const {
    idiomaDestino,
    canonicalReply,
    userInput,
    renderIntent,
    comparisonItems,
  } = params;

  if (renderIntent === "catalog_compare") {
    const comparisonJson = JSON.stringify(comparisonItems, null, 2);

    if (idiomaDestino === "es") {
      return [
        `Mensaje del cliente: ${userInput || "(vacío)"}`,
        "",
        "Datos resueltos desde DB para comparación:",
        comparisonJson,
        "",
        "Referencia canónica adicional:",
        canonicalReply,
        "",
        "Devuélveme una respuesta final lista para enviar que:",
        "1. explique la diferencia principal entre las opciones comparadas,",
        "2. recomiende cuál conviene más según el uso u objetivo, sin inventar información,",
        "3. termine con una sola pregunta breve que ayude a avanzar la venta.",
        "No respondas como catálogo ni como fichas separadas.",
      ].join("\n");
    }

    return [
      `Customer message: ${userInput || "(empty)"}`,
      "",
      "DB-resolved comparison data:",
      comparisonJson,
      "",
      "Additional canonical reference:",
      canonicalReply,
      "",
      "Return the final ready-to-send reply that:",
      "1. explains the main difference between the compared options,",
      "2. recommends which one fits better depending on use case or goal, without inventing information,",
      "3. ends with one brief question that helps move the sale forward.",
      "Do not answer as a catalog or as separate item cards.",
    ].join("\n");
  }

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