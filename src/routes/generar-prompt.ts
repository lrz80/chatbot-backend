// src/routes/generar-prompt.ts
// ✅ PROMPT-ONLY (sin DB), listo para copiar/pegar

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import crypto from "crypto";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

// ✅ bump para invalidar cache
const PROMPT_GEN_VERSION = "v11";

const promptCache = new Map<string, { value: string; at: number }>();

const keyOf = (tenantId: string, canal: string, funciones: string, info: string, idioma: string) =>
  crypto
    .createHash("sha256")
    .update(`${PROMPT_GEN_VERSION}::${tenantId}::${canal}::${idioma}::${funciones}::${info}`)
    .digest("hex");

// ———————————————————————————————————————————————————
// (F) Compactador simple para reducir tokens
const compact = (s: string) =>
  s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

// ———————————————————————————————————————————————————
// (A+) Helpers para extraer TODAS las URLs de descripcion/informacion
const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi;
const BARE_URL = /\bhttps?:\/\/[^\s)>\]]+/gi;

function normalizeUrl(u: string) {
  try {
    const url = new URL(u.trim());
    // conserva el hash (necesario para rutas SPA tipo Glofox)
    // quita "/" final solo si NO hay hash
    if (url.pathname.endsWith("/") && url.pathname !== "/" && !url.hash) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.href;
  } catch {
    return u.trim();
  }
}

type Canal = "whatsapp" | "instagram" | "facebook" | "preview" | "voice";
type Lang = "es" | "en";

function buildChannelRules(canal: Canal, idioma: Lang) {
  const baseES = [
    "REGLAS_DEL_CANAL",
    `- Canal: ${canal}.`,
    "- Responde como chat (no email).",
    "- Mantén el estilo conversacional, pero profesional.",
  ];

  const baseEN = [
    "CHANNEL_RULES",
    `- Channel: ${canal}.`,
    "- Reply as chat (not email).",
    "- Keep it conversational but professional.",
  ];

  const whatsappES = [
    ...baseES,
    "- Respuestas cortas. Si el contenido es largo, resume y ofrece el enlace oficial.",
    "- Evita listas enormes. Prioriza lo más importante.",
  ];

  const igfbES = [
    ...baseES,
    "- Respuestas aún más cortas (IG/FB se consume rápido).",
    "- Evita tecnicismos. 1 idea principal + CTA.",
  ];

  const previewES = [
    ...baseES,
    "- En vista previa puedes ser un poco más explicativo si el usuario lo pide.",
  ];

  const voiceES = [
    ...baseES,
    "- Frases muy cortas. Una pregunta a la vez.",
    "- Evita URLs largas; si es necesario, di 'te envío el link por mensaje' (si aplica).",
  ];

  const whatsappEN = [
    ...baseEN,
    "- Keep replies short. If info is long, summarize and offer the official link.",
    "- Avoid huge lists. Prioritize the essentials.",
  ];

  const igfbEN = [
    ...baseEN,
    "- Even shorter replies (IG/FB is fast).",
    "- Avoid jargon. One main point + CTA.",
  ];

  const previewEN = [
    ...baseEN,
    "- In preview you may be slightly more detailed if requested.",
  ];

  const voiceEN = [
    ...baseEN,
    "- Very short sentences. One question at a time.",
    "- Avoid long URLs; if needed, say you can send the link by message (if applicable).",
  ];

  const isES = idioma === "es";

  if (canal === "whatsapp") return (isES ? whatsappES : whatsappEN).join("\n");
  if (canal === "instagram" || canal === "facebook") return (isES ? igfbES : igfbEN).join("\n");
  if (canal === "voice") return (isES ? voiceES : voiceEN).join("\n");
  return (isES ? previewES : previewEN).join("\n");
}

function buildLanguageLock(idioma: Lang) {
  if (idioma === "en") {
    return [
      "LANGUAGE_LOCK (CRITICAL):",
      "- Reply 100% in English.",
      "- Do NOT switch languages mid-reply.",
      "- You may keep service names in their original language (e.g., 'Specialty Treatment'),",
      "  but the explanation MUST be in English.",
    ].join("\n");
  }

  return [
    "BLOQUEO_DE_IDIOMA (CRÍTICO):",
    "- Responde 100% en español.",
    "- NO mezcles idiomas en la misma respuesta.",
    "- Puedes mantener nombres de servicios en su idioma original (ej: 'Specialty Treatment'),",
    "  pero la explicación DEBE ser en español.",
  ].join("\n");
}

function buildResponseFormat(idioma: Lang) {
  if (idioma === "en") {
    return [
      "RESPONSE_FORMAT",
      "- 2–3 lines max (no long paragraphs).",
      "- First answer the user's direct question. Do not ask before answering.",
      "- Ask at most 1 question only if absolutely needed to proceed.",
      "- Always end with 1 clear CTA (next step).",
      "- Avoid generic filler (e.g., 'I'm here to help'). Be specific.",
    ].join("\n");
  }
  return [
    "ESTRUCTURA_DE_RESPUESTA",
    "- 2–3 líneas máximo (sin párrafos largos).",
    "- Primero responde la pregunta directa; no preguntes antes de responder.",
    "- Máximo 1 pregunta solo si es indispensable para avanzar.",
    "- Termina siempre con 1 CTA claro (próximo paso).",
    "- Evita relleno genérico (“estoy aquí para ayudarte”); sé específico.",
  ].join("\n");
}

function buildConversionMode(idioma: Lang) {
  if (idioma === "en") {
    return [
      "CONVERSION_MODE (TOP PERFORMANCE, NO PRESSURE)",
      "- Goal: turn inquiries into an action: book, buy, register, or contact.",
      "- Flow: understand → propose → close.",
      "",
      "1) Discovery (only if info is missing)",
      "- Ask 1 useful question to clarify the need.",
      "- If the user already said it, do NOT re-ask.",
      "",
      "2) Fit (1–2 points)",
      "- Highlight 1–2 RELEVANT facts/benefits from BUSINESS_CONTEXT only.",
      "",
      "3) Recommendation",
      "- Suggest the best available option (plans/prices/services) if present in context.",
      "- If they ask for something not available, say so and redirect to the closest option.",
      "",
      "4) Ethical urgency (facts only)",
      "- Use light urgency only if supported by context (hours, booking recommended, limited spots).",
      "- Never invent promos/scarcity.",
      "",
      "5) Close with CTA",
      "- Close with a single actionable next step and the correct official link (if available).",
    ].join("\n");
  }

  return [
    "MODO_CONVERSION (ALTO DESEMPEÑO, SIN SER INVASIVO)",
    "- Objetivo: convertir consultas en una acción: reservar, comprar, registrarse o contactar.",
    "- Flujo: entender → proponer → cerrar.",
    "",
    "1) Descubrimiento (solo si falta info)",
    "- Haz 1 pregunta útil para aclarar lo necesario.",
    "- Si el usuario ya lo dijo, NO repreguntes.",
    "",
    "2) Encaje (1–2 puntos)",
    "- Resalta 1–2 datos/beneficios RELEVANTES solo del CONTEXTO DEL NEGOCIO.",
    "",
    "3) Recomendación",
    "- Sugiere la mejor opción disponible si hay planes/precios/servicios en contexto.",
    "- Si piden algo que NO existe, dilo claro y redirige a lo más cercano.",
    "",
    "4) Urgencia ética (solo hechos)",
    "- Usa urgencia ligera solo si está respaldada por el contexto (horarios, recomendación de reservar, cupos).",
    "- Nunca inventes promos/escasez.",
    "",
    "5) Cierre con CTA",
    "- Cierra con un único próximo paso y el enlace oficial correcto (si existe).",
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
    if (/(book|booking|reserve|reserv|schedule|calendar|classes|appointment|day-view)/.test(s)) {
      out.reservas.push(u);
      continue;
    }
    if (/(price|pricing|plan|plans|membership|memberships|checkout|buy|pagar|compra|membres)/.test(s)) {
      out.precios.push(u);
      continue;
    }
    out.otros.push(u);
  }

  const uniq = (arr: string[]) => Array.from(new Set(arr));
  out.reservas = uniq(out.reservas);
  out.precios = uniq(out.precios);
  out.soporte = uniq(out.soporte);
  out.otros = uniq(out.otros);
  return out;
}

function buildCtaMap(idioma: Lang, groups: ReturnType<typeof classifyLinks>) {
  const pick = (arr: string[]) => (arr && arr.length ? arr[0] : "");

  const reservas = pick(groups.reservas);
  const precios = pick(groups.precios);
  const soporte = pick(groups.soporte);

  const lines: string[] = [];
  if (idioma === "en") {
    lines.push("CTA_GUIDE");
    if (reservas) lines.push(`- For schedules/bookings, use: ${reservas}`);
    if (precios) lines.push(`- For pricing/plans/payment, use: ${precios}`);
    if (soporte) lines.push(`- For support (only if needed/requested), use: ${soporte}`);
    lines.push("- If no relevant link exists, give clear instructions without inventing links.");
  } else {
    lines.push("GUIA_DE_CTA");
    if (reservas) lines.push(`- Para horarios/reservas, usa: ${reservas}`);
    if (precios) lines.push(`- Para precios/planes/pago, usa: ${precios}`);
    if (soporte) lines.push(`- Para soporte (solo si lo piden o es necesario), usa: ${soporte}`);
    lines.push("- Si no hay enlace relevante, da instrucciones claras sin inventar links.");
  }
  return lines.join("\n");
}

function extractAllLinksFromText(text: string, max = 24): string[] {
  MD_LINK.lastIndex = 0;
  const found: string[] = [];
  let m: RegExpExecArray | null;

  while ((m = MD_LINK.exec(text)) && found.length < max) {
    found.push(normalizeUrl(m[2]));
  }

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
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith("-") ? l : `${prefix}${l}`));
}

function splitLinesSmart(text: string) {
  return (text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd());
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
    ["planes", "Planes"],
    ["planes y membresias", "Planes y membresias"],
    ["planes y membresías", "Planes y membresias"],

    ["horarios", "Horarios"],
    ["horario", "Horarios"],

    ["precios", "Precios"],
    ["precios o cómo consultar precios", "Precios"],
    ["precios o como consultar precios", "Precios"],

    ["reservas", "Reservas"],
    ["reservas / contacto", "Reservas / contacto"],
    ["reservas / contacto:", "Reservas / contacto"],
    ["contacto", "Contacto"],

    ["políticas", "Políticas"],
    ["politicas", "Políticas"],
    ["política", "Políticas"],
    ["politica", "Políticas"],
  ]);

  const isUrlLine = (s: string) => /^https?:\/\//i.test(s) || /^mailto:/i.test(s) || /^tel:/i.test(s);

  // ✅ Une URLs que quedaron solas en la siguiente línea:
  const mergedLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = (lines[i] || "").trim();
    const next = (lines[i + 1] || "").trim();

    if (cur && cur.endsWith(":") && /^https?:\/\//i.test(next)) {
      mergedLines.push(`${cur} ${next}`);
      i++;
      continue;
    }
    mergedLines.push(lines[i]);
  }

  for (const raw of mergedLines) {
    const line = (raw || "").trim();
    if (!line) continue;

    if (isUrlLine(line)) {
      if (currentKey) push(currentKey, line);
      continue;
    }

    const heading = line.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \/]+):\s*$/);
    if (heading) {
      const keyNorm = normalizeKey(heading[1]);
      const canonical = allowedKeys.get(keyNorm);
      if (canonical) {
        currentKey = canonical;
        continue;
      }
      currentKey = null;
      continue;
    }

    const kvLine = line.match(/^([A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \/]{2,60}):\s*(.+)$/);
    if (kvLine) {
      const keyNorm = normalizeKey(kvLine[1]);
      const canonical = allowedKeys.get(keyNorm);
      if (canonical) {
        currentKey = canonical;
        push(currentKey, kvLine[2]);
        continue;
      }
      currentKey = null;
      continue;
    }

    if (currentKey) {
      const item = line.replace(/^[-•]\s*/, "").trim();
      if (item) push(currentKey, item);
    }
  }

  return kv;
}

function buildOperationalBusinessContext(infoClean: string, nombreNegocio: string) {
  const kv = parseKeyValueTemplate(infoClean);

  const hasTemplateSignals = Object.keys(kv).some((k) =>
    /nombre del negocio|tipo de negocio|ubicaci[oó]n|servicios|horarios|precios|reservas|contacto|planes/i.test(k)
  );

  if (hasTemplateSignals) {
    const nombre = (kv["Nombre del negocio"]?.[0] || nombreNegocio || "").trim();
    const tipo = (kv["Tipo de negocio"]?.[0] || "").trim();
    const ubic = (kv["Ubicación"]?.[0] || "").trim();
    const tel = (kv["Teléfono"]?.[0] || "").trim();

    const servicios = kv["Servicios principales"] || kv["Servicios"] || [];
    const planes = kv["Planes y membresias"] || kv["Planes"] || [];
    const horarios = kv["Horarios"] || [];
    const precios = kv["Precios"] || [];
    const reservas =
      kv["Reservas / contacto"] ||
      kv["Reservas"] ||
      kv["Contacto"] ||
      [];
    const politicas = kv["Políticas"] || [];

    const out: string[] = [];

    out.push("DATOS DEL NEGOCIO");
    out.push(
      ...toBullets(
        [
          nombre ? `Nombre: ${nombre}` : `Nombre: ${nombreNegocio}`,
          tipo ? `Tipo: ${tipo}` : "",
          ubic ? `Ubicación: ${ubic}` : "",
          tel ? `Teléfono: ${tel}` : "",
        ].filter(Boolean)
      )
    );

    if (servicios.length) {
      out.push("");
      out.push("SERVICIOS");
      out.push(...toBullets(servicios));
    }

    if (planes.length) {
      out.push("");
      out.push("PLANES Y MEMBRESIAS");
      out.push(...toBullets(planes));
    }

    if (horarios.length) {
      out.push("");
      out.push("HORARIOS");
      out.push(...toBullets(horarios));
    }

    if (precios.length) {
      out.push("");
      out.push("PRECIOS");
      out.push(...toBullets(precios));
    }

    if (reservas.length) {
      out.push("");
      out.push("RESERVAS / CONTACTO");
      out.push(...toBullets(reservas));
    }

    if (politicas.length) {
      out.push("");
      out.push("POLÍTICAS");
      out.push(...toBullets(politicas));
    }

    return compact(out.join("\n"));
  }

  const t = compact(infoClean || "");
  if (!t) return "";
  return compact(["CONOCIMIENTO DEL NEGOCIO", t].join("\n"));
}

function buildOperationalRules(funcionesClean: string) {
  const t = compact(funcionesClean || "");
  if (!t) return "";
  return compact(["REGLAS Y COMPORTAMIENTO", t].join("\n"));
}

// ——————— Extractores desde CONTEXTO (no DB) ———————
function extractServiceCandidatesFromInfoBlock(infoBlock: string): string[] {
  const t = String(infoBlock || "");
  if (!t.trim()) return [];
  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);

  const idx = lines.findIndex((l) => /^SERVICIOS$/i.test(l));
  let slice = lines;
  if (idx >= 0) {
    slice = lines.slice(idx + 1);
    const stopIdx = slice.findIndex((l) =>
      /^(PLANES\s+Y\s+MEMBRESIAS|HORARIOS|RESERVAS|RESERVAS \/ CONTACTO|POL[IÍ]TICAS|DATOS DEL NEGOCIO|CONOCIMIENTO DEL NEGOCIO|PRECIOS)$/i.test(l)
    );
    if (stopIdx >= 0) slice = slice.slice(0, stopIdx);
  }

  const items = slice
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length >= 2 && l.length <= 80)
    .filter((l) => !/^nombre:|^tipo:|^ubicaci/i.test(l));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function extractPlanCandidatesFromInfoBlock(infoBlock: string): string[] {
  const t = String(infoBlock || "");
  if (!t.trim()) return [];

  const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
  const idx = lines.findIndex((l) => /^PLANES\s+Y\s+MEMBRESIAS$/i.test(l));
  if (idx < 0) return [];

  let slice = lines.slice(idx + 1);
  const stopIdx = slice.findIndex((l) =>
    /^(SERVICIOS|HORARIOS|RESERVAS|RESERVAS \/ CONTACTO|POL[IÍ]TICAS|DATOS DEL NEGOCIO|PRECIOS)$/i.test(l)
  );
  if (stopIdx >= 0) slice = slice.slice(0, stopIdx);

  const items = slice
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter((l) => l.length >= 2 && l.length <= 90);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const k = it.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function buildPlansSummaryBlock(idioma: Lang, nombreNegocio: string, infoBlock: string) {
  const plans = extractPlanCandidatesFromInfoBlock(infoBlock);
  const top = plans.slice(0, 7);
  if (!top.length) return "";

  if (idioma === "en") {
    return compact([
      "PLANS_SUMMARY (FROM CONTEXT, NAMES ONLY):",
      `- Business: ${nombreNegocio}`,
      ...top.map((p) => `- ${p}`),
      "",
      'Rule: If asked "what plans do you have?", reply using ONLY this list.',
      'Then ask ONE question: "Which plan are you interested in?"',
    ].join("\n"));
  }

  return compact([
    "RESUMEN_DE_PLANES (DESDE CONTEXTO, SOLO NOMBRES):",
    `- Negocio: ${nombreNegocio}`,
    ...top.map((p) => `- ${p}`),
    "",
    'Regla: Si preguntan "¿qué planes tienes?", responde usando SOLO esta lista.',
    'Luego haz UNA pregunta: "¿Cuál plan te interesa?"',
  ].join("\n"));
}

function buildCatalogSummaryBlock(idioma: Lang, nombreNegocio: string, infoBlock: string) {
  const services = extractServiceCandidatesFromInfoBlock(infoBlock);
  const top = services.slice(0, 7);
  if (!top.length) return "";

  if (idioma === "en") {
    return compact([
      "CATALOG_SUMMARY (FROM CONTEXT, DO NOT LIST EVERYTHING):",
      `- Business: ${nombreNegocio}`,
      ...top.map((s) => `- ${s}`),
      "",
      'Rule: If user asks services/menu/catalog, reply using ONLY this short summary and ask:',
      '"Which service are you looking for?"',
    ].join("\n"));
  }

  return compact([
    "RESUMEN_DE_SERVICIOS (DESDE CONTEXTO, NO LISTAR TODO):",
    `- Negocio: ${nombreNegocio}`,
    ...top.map((s) => `- ${s}`),
    "",
    'Regla: Si piden servicios/menú/catálogo, responde SOLO con este resumen y pregunta:',
    '"¿Qué servicio estás buscando?"',
  ].join("\n"));
}

function buildServicesSummaryOnlyBlock(idioma: Lang, nombreNegocio: string, services: string[]) {
  const topServices = (services || []).slice(0, 7);
  if (!topServices.length) return "";

  if (idioma === "en") {
    return compact([
      "SERVICES_SUMMARY_FOR_INFO (FROM CONTEXT, SERVICES ONLY):",
      `- Business: ${nombreNegocio}`,
      ...topServices.map((s) => `- ${s}`),
      "",
      'Rule: If user asks "more info / info / more information" without specifying WHAT, reply using ONLY this list.',
      'Then ask ONE question: "Which service are you interested in?"',
    ].join("\n"));
  }

  return compact([
    "RESUMEN_DE_SERVICIOS_PARA_INFO (DESDE CONTEXTO, SOLO SERVICIOS):",
    `- Negocio: ${nombreNegocio}`,
    ...topServices.map((s) => `- ${s}`),
    "",
    'Regla: Si piden "más info" sin especificar QUÉ, responde SOLO con esta lista.',
    'Luego haz UNA pregunta: "¿En cuál servicio estás interesado?"',
  ].join("\n"));
}

// ———————————————————————————————————————————————————

router.post("/", async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;
    const { descripcion, informacion, idioma, canal } = req.body;

    const canalNorm = (String(canal || "preview").toLowerCase().trim() as Canal);
    const allowed = new Set<Canal>(["whatsapp", "instagram", "facebook", "preview", "voice"]);
    if (!allowed.has(canalNorm)) {
      return res.status(400).json({ error: "Canal inválido" });
    }

    const idiomaNorm: Lang = idioma === "en" ? "en" : "es";

    const MAX = 14_000; // caracteres
    const descripcionCapped = (descripcion || "").slice(0, MAX);
    const informacionCapped = (informacion || "").slice(0, MAX);

    const funciones = compact(descripcionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));
    const info = compact(informacionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));

    if (!funciones || !info) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    if (!tenant.membresia_activa) {
      return res.status(403).json({ error: "Membresía inactiva. Actívala para generar prompts." });
    }

    const nombreNegocio = tenant.name || "nuestro negocio";

    const cacheKey = keyOf(tenant_id, canalNorm, funciones, info, idiomaNorm);
    const hit = promptCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 1000 * 60 * 60 * 12) {
      return res.status(200).json({ prompt: hit.value });
    }

    // (A) URLs oficiales desde el propio contenido
    const enlacesOficiales = extractAllLinksFromText(`${funciones}\n\n${info}`, 24);

    const linkGroups = classifyLinks(enlacesOficiales);
    const channelRules = buildChannelRules(canalNorm, idiomaNorm);
    const responseFormat = buildResponseFormat(idiomaNorm);
    const languageLock = buildLanguageLock(idiomaNorm);
    const conversionMode = buildConversionMode(idiomaNorm);
    const ctaGuide = enlacesOficiales.length ? buildCtaMap(idiomaNorm, linkGroups) : "";

    const catalogAntiSpamRules =
      idiomaNorm === "en"
        ? compact([
            "CATALOG_RULES (CRITICAL):",
            "- Never paste the full catalog list from BUSINESS_CONTEXT.",
            '- If user asks "what plans do you have?":',
            "  1) Answer ONLY with PLANS_SUMMARY (max 7 bullets).",
            '  2) Ask ONE question: "Which plan are you interested in?"',
            '- If user asks "more info / info / more information" without specifying what:',
            "  1) Answer ONLY with SERVICES_SUMMARY_FOR_INFO (max 7 bullets).",
            '  2) Ask ONE question: "Which service are you interested in?"',
            "- If user asks services/menu/catalog:",
            "  1) Answer with the short summary (max 7 bullets).",
            "  2) Ask ONE question: Which service are you looking for?",
            "- If they ask for prices without specifying a plan/service: show PLANS_SUMMARY (max 5) and ask which one.",
          ].join("\n"))
        : compact([
            "REGLAS_DE_CATALOGO (CRÍTICO):",
            "- Nunca pegues la lista completa del catálogo desde CONTEXTO_DEL_NEGOCIO.",
            '- Si preguntan "¿qué planes tienes?" / paquetes / membresías:',
            "  1) Responde SOLO con RESUMEN_DE_PLANES (máx 7 bullets).",
            '  2) Haz UNA pregunta: "¿Cuál plan te interesa?"',
            '- Si piden "más info" sin especificar QUÉ:',
            "  1) Responde SOLO con RESUMEN_DE_SERVICIOS_PARA_INFO (máx 7 bullets).",
            '  2) Haz UNA pregunta: "¿En cuál servicio estás interesado?"',
            "- Si piden servicios/menú/catálogo:",
            "  1) Responde con el resumen corto (máx 7 bullets).",
            '  2) Haz UNA pregunta: "¿Qué servicio estás buscando?"',
            "- Si preguntan por precios sin especificar: muestra RESUMEN_DE_PLANES (máx 5) y pregunta cuál le interesa.",
          ].join("\n"));

    function stripModeLine(text: string) {
      return (text || "")
        .replace(/^#\s+.*$/gm, "")
        .replace(/^MODO_PROMPT:\s*(ATENCION|ACTIVACION)\s*$/gmi, "")
        .trim();
    }

    const funcionesClean = stripModeLine(funciones);
    const infoClean = stripModeLine(info);

    const infoOperativo = buildOperationalBusinessContext(infoClean, nombreNegocio);
    const reglasOperativas = buildOperationalRules(funcionesClean);

    const infoBlock = infoOperativo ? infoOperativo : "";
    const funcionesBlock = reglasOperativas ? reglasOperativas : "";

    // ✅ PROMPT-ONLY: resúmenes salen SOLO del CONTEXTO (no DB)
    const plansSummaryBlock = buildPlansSummaryBlock(idiomaNorm, nombreNegocio, infoOperativo);
    const servicesSummaryBlock = buildCatalogSummaryBlock(idiomaNorm, nombreNegocio, infoOperativo);

    const servicesOnly = extractServiceCandidatesFromInfoBlock(infoOperativo);
    const servicesSummaryOnlyBlock = buildServicesSummaryOnlyBlock(idiomaNorm, nombreNegocio, servicesOnly);

    const linksPolicy = enlacesOficiales.length
      ? idiomaNorm === "en"
        ? [
            "LINK_POLICY",
            "- Use only URLs listed in OFFICIAL_LINKS.",
            "- Max 2 links per reply (ideally 1 CTA link).",
            "- Do not invent links and do not use shorteners.",
          ].join("\n")
        : [
            "POLITICA_DE_ENLACES",
            "- Comparte únicamente URLs listadas en ENLACES_OFICIALES.",
            "- Máximo 2 enlaces por respuesta (idealmente 1 enlace de CTA).",
            "- No inventes links ni uses acortadores.",
          ].join("\n")
      : "";

    const linksBlock = enlacesOficiales.length
      ? [
          idiomaNorm === "en" ? "OFFICIAL_LINKS" : "ENLACES_OFICIALES",
          ...enlacesOficiales.map((u) => `- ${u}`),
        ].join("\n")
      : "";

    const promptCoreParts = [
      // 1) Identidad
      `Eres Amy, el asistente virtual de ${nombreNegocio}.`,
      idiomaNorm === "en"
        ? "You chat with real customers and reply in a professional, clear, human tone."
        : "Atiendes conversaciones con clientes reales y respondes de forma profesional, clara y humana.",
      "",
      `Idioma: ${idiomaNorm}`,
      "",
      languageLock,
      "",

      // 2) Reglas por canal
      channelRules,
      "",

      // 3) Resúmenes (desde CONTEXTO)
      plansSummaryBlock || "",
      plansSummaryBlock ? "" : "",

      servicesSummaryBlock || "",
      servicesSummaryBlock ? "" : "",

      // ✅ “más info” sin especificar => SOLO SERVICIOS
      servicesSummaryOnlyBlock || "",
      servicesSummaryOnlyBlock ? "" : "",

      // ✅ Anti-spam
      catalogAntiSpamRules,
      "",

      infoBlock ? (idiomaNorm === "en" ? "BUSINESS_CONTEXT (REFERENCE ONLY)" : "CONTEXTO_DEL_NEGOCIO (SOLO REFERENCIA)") : "",
      infoBlock || "",
      "",

      // 4) Comportamiento del tenant
      funcionesBlock ? (idiomaNorm === "en" ? "BEHAVIOR_AND_STYLE" : "COMPORTAMIENTO_Y_ESTILO") : "",
      funcionesBlock || "",
      "",

      // 5) Formato + conversión
      responseFormat,
      "",
      conversionMode,
      "",

      // 6) Reglas universales (✅ PROMPT-ONLY, NO DB)
      idiomaNorm === "en" ? "RULES" : "REGLAS",
      ...(idiomaNorm === "en"
        ? [
            "- Never invent information.",
            "- If a critical detail is missing, ask only what is necessary.",
            "- Keep replies brief and clear.",
            "- Do not ask questions before answering a direct question.",
            "- Ask at most 1 question only if needed.",
            "- Do not repeat long text verbatim; paraphrase briefly when needed.",
            "- Prices/schedules/details must come ONLY from BUSINESS_CONTEXT. If not present, say you don't have it and offer the official link from OFFICIAL_LINKS.",
            "- If asked 'what are your prices?' without a specific item: do NOT list everything; show PLANS_SUMMARY (max 5) and ask which plan.",
          ]
        : [
            "- No inventes información.",
            "- Si falta un dato crítico, pide solo lo mínimo.",
            "- Respuestas breves y claras.",
            "- No hagas preguntas antes de responder una pregunta directa.",
            "- Máximo 1 pregunta si es necesaria.",
            "- No repitas textos largos literalmente; parafrasea breve cuando sea necesario.",
            "- Precios/horarios/detalles salen SOLO de CONTEXTO_DEL_NEGOCIO. Si no están ahí, dilo claro y ofrece el link oficial en ENLACES_OFICIALES.",
            "- Si preguntan 'cuáles son los precios' sin especificar: NO listes todo; muestra RESUMEN_DE_PLANES (máx 5) y pregunta cuál plan.",
          ]),
      "",

      // 7) Guía CTA + enlaces
      ctaGuide || "",
      "",
      linksPolicy || "",
      linksBlock || "",
    ].filter(Boolean);

    const promptFinal = compact(promptCoreParts.join("\n"));

    promptCache.set(cacheKey, { value: promptFinal, at: Date.now() });

    return res.status(200).json({
      prompt: promptFinal,
      enlacesOficiales,
    });
  } catch (err) {
    console.error("❌ Error generando prompt:", err);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
