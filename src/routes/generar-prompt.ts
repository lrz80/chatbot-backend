// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import crypto from "crypto";                 // (B) Cache por checksum (sha256)

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

// (B) Cache en memoria por proceso
// Clave = sha256(PROMPT_GEN_VERSION + tenant_id + idioma + funciones + info)
const PROMPT_GEN_VERSION = "v17"; // ⬅️ cambia esto cada vez que ajustes la lógica del generador

const promptCache = new Map<string, { value: string; at: number }>();

const keyOf = (
  tenantId: string,
  canal: string,
  funciones: string,
  info: string,
  idioma: string,
) =>
  crypto
    .createHash("sha256")
    .update(
      `${PROMPT_GEN_VERSION}::${tenantId}::${canal}::${idioma}::${funciones}::${info}`
    )
    .digest("hex");

// ———————————————————————————————————————————————————
// (F) Compactador simple para reducir tokens
const compact = (s: string) =>
  s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// ———————————————————————————————————————————————————
// (A+) Helpers para extraer TODAS las URLs de descripcion/informacion
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL = /\bhttps?:\/\/[^\s)>\]]+/gi;

function stripKnownHeadings(text: string) {
  const t = splitLinesSmart(text);
  const kill = new Set([
    "COMPORTAMIENTO_Y_ESTILO",
    "REGLAS Y COMPORTAMIENTO",
    "COMPORTAMIENTO Y ESTILO",
    "REGLAS PRINCIPALES",
    "REGLAS DE CALIDAD",
    "REGLA PARA PREGUNTAS DE PRECIOS",
    "REGLAS DE COMUNICACIÓN SOBRE PRECIOS",
    "ESTRUCTURA_DE_RESPUESTA",
    "ESTRUCTURA GENERAL DE RESPUESTA",
    "MODO_CONVERSION",
    "MODO DE CONVERSIÓN",
    "REGLAS_DEL_CANAL",
    "CHANNEL_RULES",
    "RULES",
    "REGLAS",
    "ENLACES_OFICIALES",
    "OFFICIAL_LINKS",
    "GUIA_DE_CTA",
    "CTA_GUIDE",
    "POLITICA_DE_ENLACES",
    "LINK_POLICY",
  ]);

  const out: string[] = [];
  for (const line of t) {
    const s = String(line || "").trim();
    if (!s) continue;

    // heading puro (sin bullets) que coincide con nuestros bloques
    const normalized = s.replace(/:$/, "").toUpperCase();
    if (kill.has(normalized)) continue;

    out.push(line);
  }
  return compact(out.join("\n"));
}

function stripGeneratedPolicySections(text: string): string {
  const generatedHeadings = new Set([
    "REGLAS_DEL_CANAL",
    "CHANNEL_RULES",
    "LANGUAGE_RULES",
    "ESTRUCTURA_DE_RESPUESTA",
    "RESPONSE_FORMAT",
    "MODO_CONVERSION",
    "MODO DE CONVERSIÓN",
    "CONVERSION_MODE",
    "REGLAS_CONVERSACIONALES",
    "CONVERSATION_RULES",
    "REGLA_INTENCION_VAGA",
    "REGLA_INTENCIÓN_VAGA",
    "VAGUE_INTENT",
    "REGLA_CLASE_DE_PRUEBA",
    "TRIAL_OR_FIRST_VISIT",
    "REGLA_HORARIOS",
    "SCHEDULES",
    "REGLA_PRECIOS_ESTRUCTURA",
    "PRICING",
    "ENLACES Y CTA",
    "GUIA_DE_CTA",
    "GUÍA_DE_CTA",
    "CTA_GUIDE",
    "POLITICA_DE_ENLACES",
    "POLÍTICA_DE_ENLACES",
    "LINK_POLICY",
    "ENLACES_OFICIALES",
    "OFFICIAL_LINKS",
    "REGLAS",
    "RULES",
  ]);

  const normalizeHeading = (line: string): string =>
    line
      .trim()
      .replace(/:$/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .trim()
      .toUpperCase();

  const isKnownGeneratedHeading = (line: string): boolean =>
    generatedHeadings.has(normalizeHeading(line));

  const looksLikeCustomSectionHeading = (line: string): boolean => {
    const value = line.trim();

    if (!value || value.startsWith("-")) {
      return false;
    }

    if (/^\d+[.)]\s+/.test(value)) {
      return false;
    }

    return /^[A-ZÁÉÍÓÚÜÑ0-9_ /—-]{3,}$/.test(value);
  };

  const lines = splitLinesSmart(text);
  const output: string[] = [];

  let skipping = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (isKnownGeneratedHeading(line)) {
      skipping = true;
      continue;
    }

    if (skipping && looksLikeCustomSectionHeading(line)) {
      skipping = false;
    }

    if (!skipping) {
      output.push(rawLine);
    }
  }

  return compact(output.join("\n"));
}

function normalizeUrl(u: string) {
  try {
    const url = new URL(u.trim());
    // conserva el hash (necesario para rutas SPA tipo Glofox)
    // quita "/" final solo si NO hay hash
    if (url.pathname.endsWith('/') && url.pathname !== '/' && !url.hash) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // usar href para conservar hash tal cual
    return url.href;
  } catch {
    return u.trim();
  }
}

type Canal = "whatsapp" | "meta" | "preview";
type Lang = "es" | "en" | "pt";

function classifyLinks(links: string[]) {
  const out = {
    reservas: [] as string[],
    precios: [] as string[],
    soporte: [] as string[],
    otros: [] as string[],
  };

  for (const u of links || []) {
    const s = u.toLowerCase();
    if (s.includes("wa.me") || s.startsWith("tel:") || s.startsWith("mailto:")) {
      out.soporte.push(u);
      continue;
    }
    if (
      /(book|booking|reserve|reserv|schedule|calendar|classes|appointment|day-view)/.test(s)
    ) {
      out.reservas.push(u);
      continue;
    }
    if (
      /(price|pricing|plan|plans|membership|memberships|checkout|buy|pagar|compra|membres)/.test(s)
    ) {
      out.precios.push(u);
      continue;
    }
    out.otros.push(u);
  }

  // dedupe simple manteniendo orden
  const uniq = (arr: string[]) => Array.from(new Set(arr));
  out.reservas = uniq(out.reservas);
  out.precios = uniq(out.precios);
  out.soporte = uniq(out.soporte);
  out.otros = uniq(out.otros);
  return out;
}

function buildIdentity(idioma: Lang, businessName: string): string {
  if (idioma === "en") {
    return [
      `You are Amy, the virtual assistant for ${businessName}.`,
      "You communicate with real customers in a professional, clear, accurate, and human manner.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      `Você é Amy, a assistente virtual da ${businessName}.`,
      "Você atende clientes reais e responde de forma profissional, clara, precisa e humana.",
    ].join("\n");
  }

  return [
    `Eres Amy, la asistente virtual de ${businessName}.`,
    "Atiendes conversaciones con clientes reales y respondes de forma profesional, clara, precisa y humana.",
  ].join("\n");
}

function buildLanguageRules(idioma: Lang): string {
  if (idioma === "en") {
    return [
      "LANGUAGE_RULES",
      "- Detect the language used by the customer and reply in that same language.",
      "- Continue using the customer's language unless the customer requests a different language.",
      "- Business information may be written in another language. Translate it naturally when replying.",
      "- Never alter URLs, phone numbers, prices, plan names, official product names, dates, or times.",
      "- Do not confuse the assistant's response language with the language in which a service, class, event, or appointment is provided.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      "REGRAS_DE_IDIOMA",
      "- Detecte o idioma usado pelo cliente e responda nesse mesmo idioma.",
      "- Continue usando o idioma do cliente, a menos que ele solicite outro idioma.",
      "- As informações do negócio podem estar escritas em outro idioma. Traduza-as naturalmente ao responder.",
      "- Nunca altere URLs, números de telefone, preços, nomes de planos, nomes oficiais de produtos, datas ou horários.",
      "- Não confunda o idioma da resposta da assistente com o idioma em que um serviço, aula, evento ou agendamento é oferecido.",
    ].join("\n");
  }

  return [
    "REGLAS_DE_IDIOMA",
    "- Detecta el idioma utilizado por el cliente y responde en ese mismo idioma.",
    "- Continúa usando el idioma del cliente, salvo que solicite cambiarlo.",
    "- La información del negocio puede estar escrita en otro idioma. Tradúcela naturalmente al responder.",
    "- Nunca alteres URLs, números de teléfono, precios, nombres de planes, nombres oficiales de productos, fechas ni horarios.",
    "- No confundas el idioma de respuesta del asistente con el idioma en que se ofrece un servicio, clase, evento o cita.",
  ].join("\n");
}

function buildChannelRules(canal: Canal, idioma: Lang): string {
  if (idioma === "en") {
    const lines = [
      "CHANNEL_RULES",
      `- Channel: ${canal}.`,
      "- Reply as a chat message, not as an email.",
      "- Keep the tone conversational, professional, clear, and human.",
    ];

    if (canal === "whatsapp") {
      lines.push(
        "- Keep simple replies short.",
        "- When the requested information is extensive, include only relevant details.",
        "- Avoid unnecessarily large lists."
      );
    } else if (canal === "meta") {
      lines.push(
        "- Keep replies especially concise.",
        "- Avoid unnecessary jargon.",
        "- Focus on one main answer and one relevant next step."
      );
    } else {
      lines.push(
        "- Provide additional detail when the user explicitly requests it."
      );
    }

    return lines.join("\n");
  }

  if (idioma === "pt") {
    const lines = [
      "REGRAS_DO_CANAL",
      `- Canal: ${canal}.`,
      "- Responda como mensagem de chat, não como e-mail.",
      "- Mantenha um tom conversacional, profissional, claro e humano.",
    ];

    if (canal === "whatsapp") {
      lines.push(
        "- Mantenha respostas simples e curtas.",
        "- Quando a informação solicitada for extensa, inclua apenas os detalhes relevantes.",
        "- Evite listas desnecessariamente longas."
      );
    } else if (canal === "meta") {
      lines.push(
        "- Mantenha as respostas especialmente curtas.",
        "- Evite termos técnicos desnecessários.",
        "- Concentre-se em uma resposta principal e um próximo passo relevante."
      );
    } else {
      lines.push(
        "- Forneça mais detalhes quando o usuário solicitar explicitamente."
      );
    }

    return lines.join("\n");
  }

  const lines = [
    "REGLAS_DEL_CANAL",
    `- Canal: ${canal}.`,
    "- Responde como mensaje de chat, no como correo electrónico.",
    "- Mantén un tono conversacional, profesional, claro y humano.",
  ];

  if (canal === "whatsapp") {
    lines.push(
      "- Mantén breves las respuestas simples.",
      "- Cuando la información solicitada sea extensa, incluye únicamente los detalles relevantes.",
      "- Evita listas innecesariamente extensas."
    );
  } else if (canal === "meta") {
    lines.push(
      "- Mantén las respuestas especialmente breves.",
      "- Evita tecnicismos innecesarios.",
      "- Enfócate en una respuesta principal y un próximo paso relevante."
    );
  } else {
    lines.push(
      "- Proporciona más detalles cuando el usuario lo solicite expresamente."
    );
  }

  return lines.join("\n");
}

function buildResponseFormat(idioma: Lang): string {
  if (idioma === "en") {
    return [
      "RESPONSE_FORMAT",
      "- For simple questions, reply in 2–3 short lines.",
      "- For prices, schedules, comparisons, requirements, or policies, use the space needed to answer correctly, but include only relevant information.",
      "- Answer the customer's direct question before asking for additional information.",
      "- Ask at most one question when information is genuinely needed to proceed.",
      "- End with one relevant CTA only when the customer has expressed a specific intent.",
      "- If the customer's message is vague, finish only with one brief discovery question and do not include links.",
      "- Avoid generic filler, repeated introductions, and unnecessary explanations.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      "FORMATO_DE_RESPOSTA",
      "- Para perguntas simples, responda em 2–3 linhas curtas.",
      "- Para preços, horários, comparações, requisitos ou políticas, use o espaço necessário para responder corretamente, mas inclua apenas informações relevantes.",
      "- Responda à pergunta direta do cliente antes de solicitar informações adicionais.",
      "- Faça no máximo uma pergunta quando uma informação for realmente necessária para avançar.",
      "- Termine com uma CTA relevante somente quando o cliente tiver expressado uma intenção específica.",
      "- Se a mensagem do cliente for vaga, termine apenas com uma pergunta breve de descoberta e não inclua links.",
      "- Evite frases genéricas, introduções repetidas e explicações desnecessárias.",
    ].join("\n");
  }

  return [
    "ESTRUCTURA_DE_RESPUESTA",
    "- Para preguntas simples, responde en 2–3 líneas cortas.",
    "- Para precios, horarios, comparaciones, requisitos o políticas, utiliza el espacio necesario para responder correctamente, pero incluye únicamente información relevante.",
    "- Responde la pregunta directa del cliente antes de solicitar información adicional.",
    "- Haz como máximo una pregunta cuando realmente sea necesaria para avanzar.",
    "- Termina con un CTA relevante solo cuando el cliente haya expresado una intención específica.",
    "- Si el mensaje del cliente es vago, termina únicamente con una pregunta breve de descubrimiento y no incluyas enlaces.",
    "- Evita relleno genérico, introducciones repetidas y explicaciones innecesarias.",
  ].join("\n");
}

function buildConversationRules(idioma: Lang): string {
  if (idioma === "en") {
    return [
      "CONVERSATION_RULES",
      "",
      "VAGUE_INTENT",
      "- If the customer only greets, asks for general information, or does not identify a specific need, do not send links, schedules, prices, or long lists.",
      "- Ask one brief question to identify what the customer needs.",
      "",
      "DIRECT_QUESTIONS",
      "- Answer direct questions before asking anything else.",
      "- Do not ask the customer to repeat information already provided.",
      "",
      "TRIAL_OR_FIRST_VISIT",
      "- If the customer wants a trial, demo, consultation, first class, or first visit and multiple options exist, identify the relevant option before sending a booking link.",
      "- After the customer selects an option, provide the appropriate official link when available.",
      "- Never claim that an external action was completed unless the connected system confirms it.",
      "",
      "PRICING",
      "- If the customer asks about one specific option, answer only about that option.",
      "- If the customer asks for prices generally, group available options into clear categories based on BUSINESS_CONTEXT.",
      "- Do not begin with an arbitrary minimum-to-maximum price range.",
      "- Summarize the main differences first and provide detailed terms only when relevant or requested.",
      "",
      "SCHEDULES",
      "- Mention schedules only when requested or when directly necessary.",
      "- Published schedules do not guarantee availability.",
      "- For a specific date, use the connected system or direct the customer to the official schedule.",
      "",
      "RECOMMENDATIONS",
      "- Recommend only options that exist in BUSINESS_CONTEXT.",
      "- Ask only for the minimum information needed to make a useful recommendation.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      "REGRAS_DE_CONVERSAÇÃO",
      "",
      "INTENÇÃO_VAGA",
      "- Se o cliente apenas cumprimentar, pedir informações gerais ou não identificar uma necessidade específica, não envie links, horários, preços ou listas longas.",
      "- Faça uma pergunta breve para identificar o que o cliente precisa.",
      "",
      "PERGUNTAS_DIRETAS",
      "- Responda às perguntas diretas antes de perguntar qualquer outra coisa.",
      "- Não peça ao cliente que repita informações já fornecidas.",
      "",
      "TESTE_OU_PRIMEIRA_VISITA",
      "- Se o cliente quiser um teste, demonstração, consulta, primeira aula ou primeira visita e existirem várias opções, identifique a opção relevante antes de enviar o link de reserva.",
      "- Depois que o cliente escolher uma opção, forneça o link oficial apropriado quando estiver disponível.",
      "- Nunca afirme que uma ação externa foi concluída sem confirmação do sistema conectado.",
      "",
      "PREÇOS",
      "- Se o cliente perguntar sobre uma opção específica, responda apenas sobre essa opção.",
      "- Se perguntar por preços em geral, agrupe as opções disponíveis em categorias claras com base no CONTEXTO_DO_NEGÓCIO.",
      "- Não comece com um intervalo arbitrário entre o menor e o maior preço.",
      "- Resuma primeiro as principais diferenças e forneça condições detalhadas apenas quando forem relevantes ou solicitadas.",
      "",
      "HORÁRIOS",
      "- Mencione horários somente quando solicitado ou quando forem diretamente necessários.",
      "- Horários publicados não garantem disponibilidade.",
      "- Para uma data específica, use o sistema conectado ou direcione o cliente ao horário oficial.",
      "",
      "RECOMENDAÇÕES",
      "- Recomende apenas opções existentes no CONTEXTO_DO_NEGÓCIO.",
      "- Solicite apenas as informações mínimas necessárias para fazer uma recomendação útil.",
    ].join("\n");
  }

  return [
    "REGLAS_CONVERSACIONALES",
    "",
    "INTENCIÓN_VAGA",
    "- Si el cliente solamente saluda, pide información general o no identifica una necesidad específica, no envíes enlaces, horarios, precios ni listas largas.",
    "- Haz una pregunta breve para identificar qué necesita.",
    "",
    "PREGUNTAS_DIRECTAS",
    "- Responde las preguntas directas antes de preguntar cualquier otra cosa.",
    "- No pidas al cliente que repita información que ya proporcionó.",
    "",
    "PRUEBA_O_PRIMERA_VISITA",
    "- Si el cliente quiere una prueba, demo, consulta, primera clase o primera visita y existen varias opciones, identifica la opción relevante antes de enviar el enlace de reserva.",
    "- Después de que el cliente seleccione una opción, proporciona el enlace oficial correspondiente cuando esté disponible.",
    "- Nunca afirmes que una acción externa fue completada sin confirmación del sistema conectado.",
    "",
    "PRECIOS",
    "- Si el cliente pregunta por una opción específica, responde únicamente sobre esa opción.",
    "- Si pregunta por precios en general, agrupa las opciones disponibles en categorías claras basadas en el CONTEXTO_DEL_NEGOCIO.",
    "- No comiences con un rango arbitrario entre el precio mínimo y máximo.",
    "- Resume primero las diferencias principales y proporciona las condiciones detalladas solo cuando sean relevantes o solicitadas.",
    "",
    "HORARIOS",
    "- Menciona horarios únicamente cuando sean solicitados o directamente necesarios.",
    "- Los horarios publicados no garantizan disponibilidad.",
    "- Para una fecha específica, utiliza el sistema conectado o dirige al cliente al horario oficial.",
    "",
    "RECOMENDACIONES",
    "- Recomienda únicamente opciones existentes en el CONTEXTO_DEL_NEGOCIO.",
    "- Solicita solo la información mínima necesaria para hacer una recomendación útil.",
  ].join("\n");
}

function buildConversionMode(idioma: Lang): string {
  if (idioma === "en") {
    return [
      "CONVERSION_MODE",
      "- Goal: help the customer take the most relevant next action without being pushy.",
      "- Flow: understand → answer → recommend → next step.",
      "- Use information already provided by the customer.",
      "- Ask one question only when a critical detail is missing.",
      "- Recommend only options supported by BUSINESS_CONTEXT.",
      "- Use urgency only when supported by real business information.",
      "- When intent is specific, finish with one clear next step and the relevant official link.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      "MODO_DE_CONVERSÃO",
      "- Objetivo: ajudar o cliente a realizar a próxima ação mais relevante sem pressioná-lo.",
      "- Fluxo: entender → responder → recomendar → próximo passo.",
      "- Use as informações já fornecidas pelo cliente.",
      "- Faça uma pergunta somente quando faltar um detalhe crítico.",
      "- Recomende apenas opções respaldadas pelo CONTEXTO_DO_NEGÓCIO.",
      "- Use urgência somente quando estiver respaldada por informações reais do negócio.",
      "- Quando a intenção for específica, termine com um próximo passo claro e o link oficial relevante.",
    ].join("\n");
  }

  return [
    "MODO_CONVERSION",
    "- Objetivo: ayudar al cliente a realizar la próxima acción más relevante sin presionarlo.",
    "- Flujo: entender → responder → recomendar → próximo paso.",
    "- Utiliza la información que el cliente ya proporcionó.",
    "- Haz una pregunta únicamente cuando falte un dato crítico.",
    "- Recomienda solo opciones respaldadas por el CONTEXTO_DEL_NEGOCIO.",
    "- Utiliza urgencia únicamente cuando esté respaldada por información real del negocio.",
    "- Cuando la intención sea específica, termina con un próximo paso claro y el enlace oficial relevante.",
  ].join("\n");
}

function buildCtaMap(
  idioma: Lang,
  groups: ReturnType<typeof classifyLinks>
): string {
  const pick = (values: string[]) => (values.length ? values[0] : "");

  const booking = pick(groups.reservas);
  const pricing = pick(groups.precios);
  const support = pick(groups.soporte);

  if (idioma === "en") {
    const lines = ["CTA_GUIDE"];

    if (booking) {
      lines.push(`- For schedules, availability, or bookings, use: ${booking}`);
    }

    if (pricing) {
      lines.push(`- For pricing, plans, memberships, or payments, use: ${pricing}`);
    }

    if (support) {
      lines.push(`- For human support, use only when requested or necessary: ${support}`);
    }

    lines.push(
      "- If no relevant official link exists, provide clear instructions without inventing a URL.",
      "- Do not send a link when the customer's intent is vague.",
      "- Use one link whenever one link is sufficient."
    );

    return lines.join("\n");
  }

  if (idioma === "pt") {
    const lines = ["GUIA_DE_CTA"];

    if (booking) {
      lines.push(`- Para horários, disponibilidade ou reservas, use: ${booking}`);
    }

    if (pricing) {
      lines.push(`- Para preços, planos, associações ou pagamentos, use: ${pricing}`);
    }

    if (support) {
      lines.push(`- Para suporte humano, use somente quando solicitado ou necessário: ${support}`);
    }

    lines.push(
      "- Se não existir um link oficial relevante, forneça instruções claras sem inventar uma URL.",
      "- Não envie links quando a intenção do cliente for vaga.",
      "- Use apenas um link quando ele for suficiente."
    );

    return lines.join("\n");
  }

  const lines = ["GUIA_DE_CTA"];

  if (booking) {
    lines.push(`- Para horarios, disponibilidad o reservas, utiliza: ${booking}`);
  }

  if (pricing) {
    lines.push(`- Para precios, planes, membresías o pagos, utiliza: ${pricing}`);
  }

  if (support) {
    lines.push(`- Para soporte humano, utiliza solo cuando sea solicitado o necesario: ${support}`);
  }

  lines.push(
    "- Si no existe un enlace oficial relevante, proporciona instrucciones claras sin inventar una URL.",
    "- No envíes enlaces cuando la intención del cliente sea vaga.",
    "- Utiliza un solo enlace cuando sea suficiente."
  );

  return lines.join("\n");
}

function getPromptHeadings(idioma: Lang) {
  if (idioma === "en") {
    return {
      businessContext: "BUSINESS_CONTEXT",
      tenantInstructions: "TENANT_SPECIFIC_INSTRUCTIONS",
      rules: "RULES",
      linkPolicy: "LINK_POLICY",
      officialLinks: "OFFICIAL_LINKS",
    };
  }

  if (idioma === "pt") {
    return {
      businessContext: "CONTEXTO_DO_NEGÓCIO",
      tenantInstructions: "INSTRUÇÕES_ESPECÍFICAS_DO_TENANT",
      rules: "REGRAS",
      linkPolicy: "POLÍTICA_DE_LINKS",
      officialLinks: "LINKS_OFICIAIS",
    };
  }

  return {
    businessContext: "CONTEXTO_DEL_NEGOCIO",
    tenantInstructions: "INSTRUCCIONES_ESPECÍFICAS_DEL_TENANT",
    rules: "REGLAS",
    linkPolicy: "POLÍTICA_DE_ENLACES",
    officialLinks: "ENLACES_OFICIALES",
  };
}

function buildUniversalRules(idioma: Lang): string {
  if (idioma === "en") {
    return [
      "RULES",
      "- Never invent information.",
      "- Use BUSINESS_CONTEXT as the source of truth for business-specific facts.",
      "- If a critical detail is missing, ask only for the minimum information needed.",
      "- Do not ask a question before answering a direct question.",
      "- Do not repeat information the customer already provided.",
      "- Do not reproduce large sections of BUSINESS_CONTEXT verbatim.",
      "- Summarize and adapt the information to the customer's specific question.",
      "- Never claim that an external action was completed without confirmation from the connected system.",
    ].join("\n");
  }

  if (idioma === "pt") {
    return [
      "REGRAS",
      "- Nunca invente informações.",
      "- Use o CONTEXTO_DO_NEGÓCIO como fonte de verdade para informações específicas do negócio.",
      "- Se faltar um detalhe crítico, solicite apenas a informação mínima necessária.",
      "- Não faça uma pergunta antes de responder a uma pergunta direta.",
      "- Não repita informações que o cliente já forneceu.",
      "- Não reproduza grandes seções do CONTEXTO_DO_NEGÓCIO literalmente.",
      "- Resuma e adapte as informações à pergunta específica do cliente.",
      "- Nunca afirme que uma ação externa foi concluída sem confirmação do sistema conectado.",
    ].join("\n");
  }

  return [
    "REGLAS",
    "- Nunca inventes información.",
    "- Utiliza el CONTEXTO_DEL_NEGOCIO como fuente de verdad para la información específica del negocio.",
    "- Si falta un dato crítico, solicita únicamente la información mínima necesaria.",
    "- No hagas una pregunta antes de responder una pregunta directa.",
    "- No repitas información que el cliente ya proporcionó.",
    "- No reproduzcas literalmente grandes secciones del CONTEXTO_DEL_NEGOCIO.",
    "- Resume y adapta la información a la pregunta específica del cliente.",
    "- Nunca afirmes que una acción externa fue completada sin confirmación del sistema conectado.",
  ].join("\n");
}

function extractAllLinksFromText(text: string, max = 24): string[] {
  MD_LINK.lastIndex = 0;
  const found: string[] = [];
  let m: RegExpExecArray | null;

  // 1) markdown [label](url)
  while ((m = MD_LINK.exec(text)) && found.length < max) {
    found.push(normalizeUrl(m[2]));
  }

  // 2) bare urls
  const existing = new Set(found);
  const bare = text.match(BARE_URL) || [];
  for (const raw of bare) {
    const url = normalizeUrl(raw);
    if (!existing.has(url)) {
      found.push(url);
      existing.add(url);
      if (found.length >= max) break;
    }
  }

  // 3) de-dup por host+path+search+hash (no pierdas variantes)
  const uniq = new Map<string, string>();
  for (const u of found) {
    try {
      const p = new URL(u);
      const key = `${p.hostname}${p.pathname}${p.search}${p.hash}`;
      if (!uniq.has(key)) uniq.set(key, u);
    } catch {
      if (!uniq.has(u)) uniq.set(u, u);
    }
  }
  return Array.from(uniq.values());
}

function toBullets(lines: string[], prefix = "- ") {
  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (l.startsWith("-") ? l : `${prefix}${l}`));
}

function splitLinesSmart(text: string) {
  return (text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map(l => l.trimEnd());
}

// Parsea plantillas estilo:
// "Nombre del negocio: X", "Servicios principales:", "- a", "- b", etc.
function parseKeyValueTemplate(text: string) {
  const lines = splitLinesSmart(text);

  const kv: Record<string, string[]> = {};
  let currentKey: string | null = null;

  const push = (key: string, value: string) => {
    const k = key.trim();
    if (!kv[k]) kv[k] = [];
    const v = (value || "").trim();
    if (v) kv[k].push(v);
  };

  // ✅ Solo permitimos headings conocidos (multi-negocio)
  const normalizeKey = (raw: string) => raw.trim().toLowerCase();

  const allowedKeys = new Map<string, string>([
    ["nombre del negocio", "Nombre del negocio"],
    ["tipo de negocio", "Tipo de negocio"],
    ["ubicación", "Ubicación"],
    ["ubicacion", "Ubicación"],
    ["teléfono", "Teléfono"],
    ["telefono", "Teléfono"],

    ["servicios", "Servicios"],
    ["servicios principales", "Servicios principales"],

    ["horarios", "Horarios"],
    ["horario", "Horarios"],

    ["precios", "Precios"],
    ["precios o cómo consultar precios", "Precios"],
    ["precios o como consultar precios", "Precios"],

        // ✅ LINKS / CONTACTO
    ["reserva", "Reserva"],
    ["reservar", "Reserva"],
    ["reservas", "Reserva"],

    ["contacto", "Contacto"],
    ["soporte", "Soporte"],
    ["support", "Soporte"],

    // (compat con el campo viejo)
    ["reservas / contacto", "Reservas / contacto"],
    ["reservas / contacto:", "Reservas / contacto"],

    ["políticas", "Políticas"],
    ["politicas", "Políticas"],
    ["política", "Políticas"],
    ["politica", "Políticas"],
  ]);

  const isUrlLine = (s: string) => /^https?:\/\//i.test(s) || /^mailto:/i.test(s) || /^tel:/i.test(s);

  // ✅ Une URLs que quedaron solas en la siguiente línea:
  // Ej:
  // "Clase Funcional Gratis:"
  // "https://...."
  const mergedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = (lines[i] || "").trim();
    const next = (lines[i + 1] || "").trim();

    if (cur && cur.endsWith(":") && /^https?:\/\//i.test(next)) {
      mergedLines.push(`${cur} ${next}`);
      i++; // saltar next
      continue;
    }
    mergedLines.push(lines[i]);
  }

  for (const raw of mergedLines) {
    const line = (raw || "").trim();
    if (!line) continue;

    // ✅ Si es URL, nunca la tomes como key: value
    if (isUrlLine(line)) {
      if (currentKey) push(currentKey, line);
      continue;
    }

    // ✅ Heading tipo "Horarios:" o "Precios:" (SIN necesidad de value)
    const heading = line.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \/]+):\s*$/);
    if (heading) {
      const keyNorm = normalizeKey(heading[1]);
      const canonical = allowedKeys.get(keyNorm);
      if (canonical) {
        currentKey = canonical;
        continue;
      }
      // si no es heading permitido, lo ignoramos (para evitar llaves basura)
      currentKey = null;
      continue;
    }

    // ✅ Formato "Key: Value" solo si Key es permitida y NO es URL
    const kvLine = line.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \/]{2,60}):\s*(.+)$/);
    if (kvLine) {
      const keyNorm = normalizeKey(kvLine[1]);
      const canonical = allowedKeys.get(keyNorm);
      if (canonical) {
        currentKey = canonical;
        push(currentKey, kvLine[2]);
        continue;
      }
      // key no permitida -> no la uses
      currentKey = null;
      continue;
    }

    // ✅ Item bajo key actual: "- item" o "• item"
    if (currentKey) {
      const item = line.replace(/^[-•]\s*/, "").trim();
      if (item) push(currentKey, item);
    }
  }

  return kv;
}

// Si el texto parece prosa (párrafo largo), lo convierte a bullets por oraciones (sin inventar nada)
function proseToBullets(text: string, maxItems = 10) {
  const t = compact(text);
  if (!t) return [];
  // split básico por ". " y también por saltos
  const parts = t
    .replace(/\n+/g, " ")
    .split(/(?<=[\.\!\?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);

  return parts.slice(0, maxItems).map(s => s.replace(/\s+/g, " "));
}

function buildOperationalBusinessContext(
  infoClean: string,
  nombreNegocio: string
): string {
  const content = compact(infoClean || "");

  if (!content) {
    return nombreNegocio
      ? `DATOS DEL NEGOCIO\n- Nombre: ${nombreNegocio}`
      : "";
  }

  /*
   * El campo "Información que el asistente debe conocer" es contenido
   * administrado por cada tenant.
   *
   * No debe reconstruirse mediante una lista cerrada de headings porque:
   * - cada negocio puede tener categorías diferentes;
   * - se perderían planes, políticas, condiciones y reglas específicas;
   * - obligaría a hardcodear nombres de secciones por industria;
   * - nuevos tenants podrían romperse silenciosamente.
   *
   * Solo compactamos espacios y preservamos íntegramente el contenido.
   */
  return content;
}

function buildOperationalRules(funcionesClean: string) {
  const t = compact(funcionesClean || "");
  if (!t) return "";
  // ✅ NO agregues encabezado aquí porque YA lo agregas en promptCoreParts
  return t;
}

// ———————————————————————————————————————————————————

router.post("/", async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;
    const { descripcion, informacion, idioma, canal } = req.body;

    // 🔥 Normalización robusta: solo whatsapp | meta | preview
    let canalNorm: Canal = "preview";

    if (typeof canal === "string") {
      const safe = canal.trim().toLowerCase();
      if (safe === "whatsapp" || safe === "meta" || safe === "preview") {
        canalNorm = safe as Canal;
      }
    }

    const allowed = new Set<Canal>(["whatsapp", "meta", "preview"]);
    if (!allowed.has(canalNorm)) {
      return res.status(400).json({ error: "Canal inválido" });
    }

    const idiomaNorm: Lang =
      idioma === "en"
        ? "en"
        : idioma === "pt"
          ? "pt"
          : "es";

    // (E) Límite de entrada (para evitar prompts kilométricos)
    const MAX = 14_000; // caracteres
    const descripcionCapped = (descripcion || "").slice(0, MAX);
    const informacionCapped = (informacion || "").slice(0, MAX);

    // (F) Normaliza saltos/espacios y compacta antes de mandar al modelo
    const funciones = compact(descripcionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));
    const info      = compact(informacionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));

    if (!funciones || !info || !idiomaNorm) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    if (!tenant.membresia_activa) {
      return res.status(403).json({ error: "Membresía inactiva. Actívala para generar prompts." });
    }

    const nombreNegocio = tenant.name || "nuestro negocio";

    // (B) Cache hit?  👉 OJO: el key incluye también el snapshot
    const cacheKey = keyOf(
      tenant_id,
      canalNorm,
      funciones,
      info,
      idiomaNorm,
    );
    const hit = promptCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 1000 * 60 * 60 * 12) {
      return res.status(200).json({ prompt: hit.value });
    }

    // Logs livianos (C)
    console.log("📤 Generar prompt:", {
      negocio: nombreNegocio,
      idioma: idiomaNorm,
      canal: canalNorm,
      funciones_chars: funciones.length,
      info_chars: info.length,
    });

    // (A) URLs oficiales desde el propio contenido
    const enlacesOficiales = extractAllLinksFromText(`${funciones}\n\n${info}`, 24);

    const linkGroups = classifyLinks(enlacesOficiales);
    const identity = buildIdentity(idiomaNorm, nombreNegocio);
    const headings = getPromptHeadings(idiomaNorm);
    const languageRules = buildLanguageRules(idiomaNorm);
    const channelRules = buildChannelRules(canalNorm, idiomaNorm);
    const responseFormat = buildResponseFormat(idiomaNorm);
    const conversationRules = buildConversationRules(idiomaNorm);
    const conversionMode = buildConversionMode(idiomaNorm);
    const universalRules = buildUniversalRules(idiomaNorm);

    const ctaGuide = enlacesOficiales.length
      ? buildCtaMap(idiomaNorm, linkGroups)
      : "";

    // ———————————————————————————————————————————————————
    // Generación determinística (sin OpenAI) para prompts consistentes
    // descripcion -> reglas / comportamiento ("Qué debe hacer tu asistente")
    // informacion -> hechos / memoria del negocio ("Información que el asistente debe conocer")

    function stripModeLine(text: string) {
      return (text || "")
        .replace(/^#\s+.*$/gm, "") // quita comentarios
        .replace(/^MODO_PROMPT:\s*(ATENCION|ACTIVACION)\s*$/gmi, "")
        .trim();
    }

    // Limpiar la línea MODO_PROMPT para que no aparezca en el prompt final
    const funcionesClean = stripModeLine(funciones);
    const infoClean = stripModeLine(info);

    const funcionesClean2 = stripGeneratedPolicySections(funcionesClean);

    // Preserve the complete tenant business knowledge.
    // Do not filter it using a fixed list of headings.
    const infoClean2 = infoClean;

    // Opcional: si tu UI no mete bullets, puedes forzar bullets line-by-line:
    // Aquí NO transformo, solo dejo lo que el usuario puso.
    const infoOperativo = buildOperationalBusinessContext(infoClean2, nombreNegocio);
    const reglasOperativas = buildOperationalRules(funcionesClean2);

    // 👇 OJO: aquí va `let`, no `const`
    let infoBlock = infoOperativo ? infoOperativo : "";
    const funcionesBlock = reglasOperativas ? reglasOperativas : "";

    const linksPolicy = enlacesOficiales.length
      ? idiomaNorm === "en"
        ? [
            headings.linkPolicy,
            `- Share only URLs listed in ${headings.officialLinks}.`,
            "- Use no more than two links in one reply and prefer one relevant CTA link.",
            "- Do not invent URLs, alter URLs, or use URL shorteners.",
            "- Do not send links when the customer's intent is vague.",
            "- Every link must be relevant to the customer's current request.",
          ].join("\n")
        : idiomaNorm === "pt"
          ? [
              headings.linkPolicy,
              `- Compartilhe somente URLs listadas em ${headings.officialLinks}.`,
              "- Use no máximo dois links por resposta e prefira um único link de CTA relevante.",
              "- Não invente URLs, não altere URLs e não use encurtadores.",
              "- Não envie links quando a intenção do cliente for vaga.",
              "- Todo link deve ser relevante para a solicitação atual do cliente.",
            ].join("\n")
          : [
              headings.linkPolicy,
              `- Comparte únicamente URLs incluidas en ${headings.officialLinks}.`,
              "- Utiliza un máximo de dos enlaces por respuesta y prefiere un único enlace de CTA relevante.",
              "- No inventes URLs, no modifiques URLs ni utilices acortadores.",
              "- No envíes enlaces cuando la intención del cliente sea vaga.",
              "- Cada enlace debe ser relevante para la solicitud actual del cliente.",
            ].join("\n")
      : "";

    const linksBlock = enlacesOficiales.length
      ? [
          headings.officialLinks,
          ...enlacesOficiales.map((url) => `- ${url}`),
        ].join("\n")
      : "";

    const promptCoreParts = [
      identity,
      "",

      languageRules,
      "",

      channelRules,
      "",

      infoBlock ? headings.businessContext : "",
      infoBlock,
      "",

      funcionesBlock ? headings.tenantInstructions : "",
      funcionesBlock,
      "",

      responseFormat,
      "",
      conversationRules,
      "",
      conversionMode,
      "",
      universalRules,
      "",

      ctaGuide,
      "",
      linksPolicy,
      linksBlock,
    ].filter((part): part is string => Boolean(part));

    const prompt = compact(promptCoreParts.join("\n"));

    // ✅ Prompt final SOLO operativo (sin política transversal de enlaces)
    const promptFinal = prompt;

    // (B) Guarda en cache para futuras llamadas idénticas
    promptCache.set(cacheKey, { value: promptFinal, at: Date.now() });

    // ✅ Devuelve enlaces separados para que los uses como wrapper global
    res.status(200).json({
      prompt: promptFinal,
      enlacesOficiales,
    });
  } catch (err) {
    console.error("❌ Error generando prompt:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
