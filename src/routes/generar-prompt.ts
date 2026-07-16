// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import crypto from "crypto";                 // (B) Cache por checksum (sha256)

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

// (B) Cache en memoria por proceso
// Clave = sha256(PROMPT_GEN_VERSION + tenant_id + idioma + funciones + info)
const PROMPT_GEN_VERSION = "v16"; // ⬅️ cambia esto cada vez que ajustes la lógica del generador

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

function buildChannelRules(canal: Canal): string {
  const base = [
    "CHANNEL_RULES",
    `- Channel: ${canal}.`,
    "- Reply as a chat message, not as an email.",
    "- Keep the tone conversational, professional, clear, and human.",
  ];

  if (canal === "whatsapp") {
    return [
      ...base,
      "- Keep simple replies short.",
      "- When the requested information is extensive, provide only the relevant details and one appropriate official link when useful.",
      "- Avoid unnecessarily large lists.",
    ].join("\n");
  }

  if (canal === "meta") {
    return [
      ...base,
      "- Keep replies especially concise because Instagram and Facebook conversations move quickly.",
      "- Avoid unnecessary jargon.",
      "- Focus on one main answer and one relevant next step.",
    ].join("\n");
  }

  return [
    ...base,
    "- In preview mode, provide additional detail when the user explicitly requests it.",
  ].join("\n");
}

function buildLanguageRules(): string {
  return [
    "LANGUAGE_RULES",
    "- Detect the language used by the customer and reply in that same language.",
    "- Continue using the customer's language unless the customer requests a different language.",
    "- Business information may be written in a different language. Translate it naturally when responding.",
    "- Never translate or alter URLs, phone numbers, prices, plan names, official product names, dates, or times.",
    "- Do not confuse the assistant's response language with the language in which a class, service, event, or appointment is provided.",
    "- When the business context specifies the language of a service, communicate that condition accurately.",
  ].join("\n");
}

function buildResponseFormat(): string {
  return [
    "RESPONSE_FORMAT",
    "- For simple questions, reply in 2–3 short lines.",
    "- For prices, schedules, comparisons, requirements, or policies, use the space needed to answer correctly, but include only information relevant to the question.",
    "- Answer the customer's direct question before asking for additional information.",
    "- Ask at most one question when information is genuinely needed to proceed.",
    "- End with one relevant CTA only when the customer has expressed a specific intent.",
    "- If the customer's message is vague, finish only with one brief discovery question and do not include links.",
    "- Avoid generic filler, repeated introductions, and unnecessary explanations.",
  ].join("\n");
}

function buildConversationRules(): string {
  return [
    "CONVERSATION_RULES",
    "",
    "VAGUE_INTENT",
    "- If the customer only greets, asks for general information, or does not identify a specific need, do not send links, schedules, prices, or long lists.",
    "- Ask one brief question to identify what the customer needs.",
    "",
    "DIRECT_QUESTIONS",
    "- When the customer asks a direct question, answer it before asking anything else.",
    "- Do not ask the customer to repeat information already provided.",
    "",
    "TRIAL_OR_FIRST_VISIT",
    "- If the customer wants a trial, demo, consultation, first class, or first visit and multiple options exist, identify the relevant option before sending a booking link.",
    "- After the customer selects an option, provide the appropriate official link when available.",
    "- Never claim that a reservation, purchase, cancellation, registration, or change was completed unless the connected system confirms it.",
    "",
    "PRICING",
    "- If the customer asks about one specific product, service, package, or plan, answer only about that option.",
    "- If the customer asks for prices generally, group the available options into clear categories based on the business context.",
    "- Do not begin with an arbitrary minimum-to-maximum price range.",
    "- Summarize the main differences first.",
    "- Provide detailed terms only when relevant or requested.",
    "",
    "SCHEDULES",
    "- Mention schedules only when requested or when directly necessary to answer the customer's question.",
    "- Published schedules do not guarantee availability.",
    "- For a specific date, use the connected booking system or direct the customer to the official schedule.",
    "",
    "RECOMMENDATIONS",
    "- Recommend only options that exist in BUSINESS_CONTEXT.",
    "- Ask only the minimum information needed to make a useful recommendation.",
    "- Do not force the customer through a long questionnaire.",
  ].join("\n");
}

function buildConversionMode(): string {
  return [
    "CONVERSION_MODE",
    "- Goal: help the customer take the most relevant next action without being pushy.",
    "- Flow: understand → answer → recommend → next step.",
    "",
    "1) Understand",
    "- Use the information the customer already provided.",
    "- Ask one question only when a critical detail is missing.",
    "",
    "2) Answer",
    "- Answer the customer's direct question accurately using BUSINESS_CONTEXT.",
    "",
    "3) Recommend",
    "- When appropriate, suggest the most relevant available service, product, package, plan, appointment, or action.",
    "- Explain one or two relevant differences or benefits.",
    "",
    "4) Ethical urgency",
    "- Use light urgency only when supported by the business context, such as limited capacity, booking requirements, deadlines, or availability.",
    "- Never invent scarcity, promotions, or deadlines.",
    "",
    "5) Next step",
    "- When the customer's intent is specific, finish with one clear next step.",
    "- Include only the official link relevant to that next step.",
  ].join("\n");
}

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

function buildCtaMap(
  groups: ReturnType<typeof classifyLinks>
): string {
  const pick = (arr: string[]) => (arr.length ? arr[0] : "");

  const booking = pick(groups.reservas);
  const pricing = pick(groups.precios);
  const support = pick(groups.soporte);

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

    const idiomaNorm = idioma === "en" ? "en" : "es";

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
    const languageRules = buildLanguageRules();
    const channelRules = buildChannelRules(canalNorm);
    const responseFormat = buildResponseFormat();
    const conversationRules = buildConversationRules();
    const conversionMode = buildConversionMode();
    const ctaGuide = enlacesOficiales.length
      ? buildCtaMap(linkGroups)
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
      ? [
          "LINK_POLICY",
          "- Share only URLs listed in OFFICIAL_LINKS.",
          "- Use no more than two links in one reply, and prefer one relevant CTA link.",
          "- Do not invent URLs, alter URLs, or use URL shorteners.",
          "- Do not send links when the customer's intent is vague.",
          "- A link must be relevant to the customer's current request.",
        ].join("\n")
      : "";

    const linksBlock = enlacesOficiales.length
      ? [
          "OFFICIAL_LINKS",
          ...enlacesOficiales.map((url) => `- ${url}`),
        ].join("\n")
      : "";

    const promptCoreParts = [
      // 1) Identity
      `You are Amy, the virtual assistant for ${nombreNegocio}.`,
      "You communicate with real customers in a professional, clear, accurate, and human manner.",
      "",

      // 2) Customer language
      languageRules,
      "",

      // 3) Channel behavior
      channelRules,
      "",

      // 4) Tenant business knowledge
      infoBlock ? "BUSINESS_CONTEXT" : "",
      infoBlock,
      "",

      // 5) Tenant-specific behavior
      funcionesBlock ? "TENANT_SPECIFIC_INSTRUCTIONS" : "",
      funcionesBlock,
      "",

      // 6) Universal conversation behavior
      responseFormat,
      "",
      conversationRules,
      "",
      conversionMode,
      "",

      // 7) Universal reliability rules
      "RULES",
      "- Never invent information.",
      "- Use BUSINESS_CONTEXT as the source of truth for business-specific facts.",
      "- If a critical detail is missing, ask only for the minimum information needed.",
      "- Do not ask a question before answering a direct question.",
      "- Do not repeat information the customer already provided.",
      "- Do not reproduce large sections of BUSINESS_CONTEXT verbatim.",
      "- Summarize and adapt the information to the customer's specific question.",
      "- Never claim that an external action was completed without confirmation from the connected system.",
      "",

      // 8) CTA and official links
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
