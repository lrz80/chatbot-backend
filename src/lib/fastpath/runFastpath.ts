// backend/src/lib/fastpath/runFastpath.ts
import type { Pool } from "pg";

import type { Canal } from "../detectarIntencion";
import type { Lang } from "../channels/engine/clients/clientDb";

import { traducirMensaje } from "../traducirMensaje";
import { traducirTexto } from "../traducirTexto";

// INFO_CLAVE includes
import { normalizeText } from "../infoclave/resolveIncludes";

// DB catalog includes
import { getServiceDetailsText } from "../services/resolveServiceInfo";

// Pricing
import { resolveServiceIdFromText } from "../services/pricing/resolveServiceIdFromText";
import { resolveBestLinkForService } from "../links/resolveBestLinkForService";
import { renderInfoGeneralOverview } from "../fastpath/renderInfoGeneralOverview";
import { getServiceAndVariantUrl } from "../services/getServiceAndVariantUrl";
import { buildCatalogContext } from "../catalog/buildCatalogContext";
import { renderGenericPriceSummaryReply } from "../services/pricing/renderGenericPriceSummaryReply";
import OpenAI from "openai";
import { extractQueryFrames, type QueryFrame } from "./extractQueryFrames";
import { resolveServiceMatchesFromText } from "../services/pricing/resolveServiceMatchesFromText";
import { answerWithPromptBase } from "../answers/answerWithPromptBase";

import type { CatalogReferenceClassification } from "../catalog/types";

import { buildCatalogRoutingSignal } from "../../lib/catalog/buildCatalogRoutingSignal";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type FastpathCtx = {
  last_service_id?: string | null;
  last_service_name?: string | null;
  last_service_at?: number | null;

  pending_price_lookup?: boolean;
  pending_price_at?: number | null;
  pending_price_target_text?: string | null;
  pending_price_raw_user_text?: string | null;

  // ✅ listas para selección posterior
  last_plan_list?: Array<{ id: string; name: string; url: string | null }>;
  last_plan_list_at?: number | null;

  last_package_list?: Array<{ id: string; name: string; url: string | null }>;
  last_package_list_at?: number | null;

  // ✅ señales estructurales (SIN COPY)
  has_packages_available?: boolean;
  has_packages_available_at?: number | null;

  last_list_kind?: "plan" | "package";
  last_list_kind_at?: number | null;

  pending_link_lookup?: boolean;
  pending_link_at?: number | null;
  pending_link_options?: Array<{ label: string; url: string }>;

  last_bot_action?: string | null;
  last_bot_action_at?: number | null;

  last_price_option_label?: string | null;
  last_price_option_at?: number | null;

  last_selected_kind?: "service" | "option" | "plan" | "package" | null;
  last_selected_id?: string | null;
  last_selected_name?: string | null;
  last_selected_at?: number | null;

  // ✅ histórico de planes listados por el motor de catálogo
  last_catalog_plans?: string[] | null;
  last_catalog_at?: number | null;

  // selección de servicio/variante para flujo "qué incluye"
  selectedServiceId?: string | null;
  expectingVariant?: boolean;

  last_variant_id?: string | null;
  last_variant_name?: string | null;
  last_variant_url?: string | null;
  last_variant_at?: number | null;

  [k: string]: any;
};

export type FastpathAwaitingEffect =
  | {
      type: "set_awaiting_yes_no";
      ttlSeconds: number;
      payload: any;
    }
  | { type: "none" };

export type FastpathHint =
  | {
      type: "price_summary";
      payload: {
        lang: Lang;
        rows: { service_name: string; min_price: number; max_price: number }[];
      };
    };

export type FastpathResult =
  | {
      handled: true;
      reply: string;
      source:
        | "service_list_db"
        | "info_clave_includes"
        | "info_clave_missing_includes"
        | "includes_fastpath_db"
        | "includes_fastpath_db_missing"
        | "includes_fastpath_db_ambiguous"
        | "price_disambiguation_db"
        | "price_missing_db"
        | "price_fastpath_db"
        | "price_summary_db"
        | "info_general_overview"
        | "price_summary_db_empty"
        | "info_clave_includes_ctx_link"
        | "interest_to_pricing"
        | "catalog_llm"
        | "fastpath_dismiss"
        | "catalog_db"
        |"price_fastpath_db_llm_render"
        |"price_fastpath_db_no_price_llm_render";
      intent: string | null;
      ctxPatch?: Partial<FastpathCtx>;
      awaitingEffect?: FastpathAwaitingEffect;
      fastpathHint?: FastpathHint;
    }
  | {
      handled: false;
      ctxPatch?: Partial<FastpathCtx>;
      fastpathHint?: FastpathHint;
    };

export type RunFastpathArgs = {
  pool: Pool;

  tenantId: string;
  canal: Canal;

  idiomaDestino: Lang;
  userInput: string;

  // Importante: el caller define si está en booking
  inBooking: boolean;

  // state context actual
  convoCtx: FastpathCtx;

  // multi-tenant: info_clave viene del tenant
  infoClave: string;
  promptBase: string;

  // intent detectada (si existe) para logging/guardado
  detectedIntent?: string | null;

  // knobs
  maxDisambiguationOptions?: number; // default 5
  lastServiceTtlMs?: number; // default 60 min

  catalogReferenceClassification?: CatalogReferenceClassification;
};

async function answerCatalogQuestionLLM(params: {
  idiomaDestino: "es" | "en";
  systemMsg: string;
  userMsg: string;
}) {
  const { systemMsg, userMsg } = params;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini", // o el modelo que estás usando en producción
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
    temperature: 0.4,
  });

  const reply = completion.choices[0]?.message?.content ?? "";
  return reply.trim();
}

function bestNameMatch(
  userText: string,
  items: Array<{ id?: string; name: string; url?: string | null }>
) {
  const u = normalizeText(userText);
  if (!u) return null;

  const hits = items.filter((it) => {
    const n = normalizeText(it.name);
    return n.includes(u) || u.includes(n);
  });

  if (hits.length === 1) return hits[0] as any;
  if (hits.length > 1) {
    return hits.sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0] as any;
  }
  return null;
}

function isFreeOfferQuestion(text: string) {
  const t = String(text || "").toLowerCase();

  const hasFreeWord = /\b(gratis|free)\b/i.test(t);
  const hasTrialWord = /\b(prueba|trial|demo|promocion|promoción)\b/i.test(t);
  const hasClassWord = /\b(clase|class)\b/i.test(t);
  const hasTryVerb = /\b(probar|try|testear|probarla|probarlo)\b/i.test(t);

  if (hasFreeWord && (hasTrialWord || hasClassWord)) return true;
  if (hasTryVerb && hasClassWord) return true;

  return false;
}

function renderFreeOfferList(args: { lang: Lang; items: { name: string }[] }) {
  const { lang, items } = args;

  const intro =
    lang === "en"
      ? "Sure! Here are the free/trial options 😊"
      : "¡Claro! Aquí tienes las opciones gratis/de prueba 😊";

  const ask =
    lang === "en"
      ? "Which one are you interested in? Reply with the number or the name."
      : "¿Cuál te interesa? Responde con el número o el nombre.";

  const listText = items
    .slice(0, 6)
    .map((x, i) => `• ${i + 1}) ${x.name}`)
    .join("\n");

  return `${intro}\n\n${listText}\n\n${ask}`;
}

function norm(s: any) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isTrialQuery(raw: string): boolean {
  const normalized = String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  return (
    normalized.includes("clase de prueba") ||
    normalized.includes("clase prueba") ||
    normalized.includes("prueba gratis") ||
    normalized.includes("clase gratis") ||
    normalized.includes("free class") ||
    normalized.includes("trial") ||
    normalized.includes("demo")
  );
}

// ✅ helper: extraer nombres de planes desde la respuesta del LLM
function extractPlanNamesFromReply(text: string): string[] {
  const lines = String(text || "").split(/\r?\n/);
  const names: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (/^[•\-\*]/.test(line)) {
      let withoutBullet = line.replace(/^[•\-\*]\s*/, "");
      const idx = withoutBullet.indexOf(":");
      if (idx > 0) {
        const name = withoutBullet.slice(0, idx).trim();
        if (name && !names.includes(name)) {
          names.push(name);
        }
      }
    }
  }

  return names;
}

// ✅ Post-procesador: elimina planes ya mencionados en PREVIOUS_PLANS_MENTIONED
function postProcessCatalogReply(params: {
  reply: string;
  questionType: "combination_and_price" | "price_or_plan" | "other_plans";
  prevNames: string[];
}) {
  const { reply, questionType, prevNames } = params;

  if (!prevNames.length) {
    return { finalReply: reply, namesShown: extractPlanNamesFromReply(reply) };
  }

  const prevSet = new Set(prevNames.map((n) => norm(n)));

  const lines = String(reply || "").split(/\r?\n/);
  const filteredLines: string[] = [];

  const bulletRegex = /^[•\-\*]\s*/;

  // Vamos a reconstruir la lista de nombres que realmente se quedan tras el filtro
  const keptNames: string[] = [];

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();

    // Si no es bullet, lo dejamos tal cual (saludos, horarios, etc.)
    if (!trimmed || !bulletRegex.test(trimmed)) {
      filteredLines.push(line);
      continue;
    }

    // Intentar extraer "Nombre del plan" antes de ":"
    const withoutBullet = trimmed.replace(bulletRegex, "");
    const colonIdx = withoutBullet.indexOf(":");
    if (colonIdx <= 0) {
      // bullet raro sin "Nombre: precio" → lo dejamos pasar
      filteredLines.push(line);
      continue;
    }

    const name = withoutBullet.slice(0, colonIdx).trim();
    const nameNorm = norm(name);

    // Si la pregunta es "otros planes", evitamos repetir los ya listados
    if (questionType === "other_plans" && prevSet.has(nameNorm)) {
      // 🔁 Duplicado → lo filtramos
      continue;
    }

    // Lo mantenemos
    filteredLines.push(line);
    keptNames.push(name);
  }

  // Si al filtrar nos quedamos sin bullets nuevos, devolvemos el original
  // para no mandar una respuesta vacía o solo texto suelto.
  if (!keptNames.length) {
    return {
      finalReply: reply,
      namesShown: extractPlanNamesFromReply(reply),
    };
  }

  return {
    finalReply: filteredLines.join("\n"),
    namesShown: keptNames,
  };
}

function extractCatalogTargetToken(raw: string): string | null {
  const t = normalizeText(raw);
  if (!t) return null;

  // Patrones útiles, pero genéricos
  let m = t.match(/\b(?:plan|paquete|package|servicio|service)\s+([a-z0-9áéíóúñ]+)\b/);
  if (m?.[1]) return m[1];

  m = t.match(/\b(?:y\s+)?(?:el|la|los|las)\s+([a-z0-9áéíóúñ]+)\b/);
  if (m?.[1]) return m[1];

  // Fallback general: quitar palabras funcionales y quedarse con el último token útil
  const tokens = t
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter(
      (x) =>
        ![
          "que",
          "q",
          "incluye",
          "incluyen",
          "detalle",
          "detalles",
          "el",
          "la",
          "los",
          "las",
          "y",
          "de",
          "del",
          "un",
          "una",
          "the",
          "a",
          "an",
          "what",
          "include",
          "includes",
          "more",
          "about",
        ].includes(x)
    );

  if (tokens.length === 1) return tokens[0];
  if (tokens.length >= 2) return tokens[tokens.length - 1];

  return null;
}

function humanizeListReply(reply: string, idioma: "es" | "en") {
  const closingEs = [
    "¿Cuál te gustaría probar?",
    "¿Quieres que te recomiende la mejor según tu objetivo? 😊",
    "Si quieres te guío según lo que estés buscando 😊",
    "¿Cuál opción te interesa más?"
  ];

  const closingEn = [
    "Which one looks best for you?",
    "Do you want me to recommend the best option for you? 😊",
    "If you want, I can guide you based on your goals 😊",
    "Which option are you leaning toward?"
  ];

  const pick = idioma === "es"
    ? closingEs[Math.floor(Math.random() * closingEs.length)]
    : closingEn[Math.floor(Math.random() * closingEn.length)];

  // Si ya contiene pregunta final, no duplicamos
  if (/interesa|interested|recommend/i.test(reply)) return reply;

  return `${reply}\n\n${pick}`;
}

function stripLinkSentences(reply: string): string {
  const lines = String(reply || "").split(/\r?\n/);

  const filtered = lines.filter((line) => {
    const l = line.toLowerCase().trim();
    if (!l) return true;

    // Si la línea habla de links / enlaces / comprar en enlaces, la quitamos
    if (
      l.includes("enlace") ||
      l.includes("enlaces") ||
      l.includes("link") ||
      l.includes("links") ||
      l.includes("comprar en los enlaces") ||
      l.includes("comprar en los links")
    ) {
      return false;
    }

    return true;
  });

  // Normaliza saltos de línea
  return filtered.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

type CatalogVariantRow = {
  option_name: string;
  service_name: string;
  variant_name: string | null;
  price_value: number | string | null;
};

function renderVariantOptionsReply(args: {
  lang: Lang;
  rows: { option_name: string; price_value: number | string | null }[];
}) {
  const { lang, rows } = args;

  const intro =
    rows.length === 1
      ? lang === "en"
        ? "Here is another option:"
        : "Aquí tienes otra opción:"
      : lang === "en"
      ? "Here are some other options:"
      : "Aquí tienes otras opciones:";

  const lines = rows
    .filter((r) => r.option_name && r.price_value !== null && r.price_value !== undefined)
    .map((r) => {
      const n = Number(r.price_value);
      const priceText =
        Number.isFinite(n) && n <= 0
          ? lang === "en"
            ? "free"
            : "gratis"
          : `$${Number(n).toFixed(2)}`;

      return `• ${r.option_name}: ${priceText}`;
    });

  const ask =
    lang === "en"
      ? "Which one are you interested in? 😊"
      : "¿Cuál de estas opciones te interesa? 😊";

  return `${intro}\n\n${lines.join("\n")}\n\n${ask}`;
}

function normalizeForIntent(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isEllipticPriceFollowup(raw: string, convoCtx: FastpathCtx): boolean {
  const text = normalizeText(String(raw || ""));
  if (!text) return false;

  const hasRecentServiceContext =
    !!String(convoCtx?.last_service_id || "").trim() ||
    !!String(convoCtx?.selectedServiceId || "").trim();

  if (!hasRecentServiceContext) return false;

  // Mensajes elípticos suelen ser cortos
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length > 6) return false;

  // Si parece introducir una entidad nueva, ya no es follow-up elíptico
  // Eso lo debe resolver el matcher normal de servicio
  const hasLikelyEntityPhrase =
    /\b(del|de la|de el|of|for)\b/.test(text) ||
    /\b(plan|paquete|package|service|servicio|bath|groom|grooming|haircut)\b/.test(text);

  if (hasLikelyEntityPhrase) return false;

  // Señales genéricas de precio
  const priceIntentTokens = new Set([
    "price",
    "pricing",
    "cost",
    "costs",
    "precio",
    "precios",
    "costo",
    "costos",
    "cuanto",
    "cuanta",
    "cuesta",
    "cuestan",
    "vale",
    "valen",
    "monthly",
    "month",
    "mensual",
    "mensualmente",
    "mes",
  ]);

  const hasPriceSignal = tokens.some((t) => priceIntentTokens.has(t));
  if (hasPriceSignal) return true;

  // También aceptar follow-ups ultra cortos numéricos o tipo "y el de 12"
  const shortEllipticShape =
    /^(y\s+)?(el|la|los|las)\s+de\s+\d{1,3}\b/.test(text) ||
    /^(y\s+)?\d{1,3}\b/.test(text);

  if (shortEllipticShape) return true;

  return false;
}

function isPriceQuestion(text: string, convoCtx?: FastpathCtx) {
  const framesSayPrice = extractQueryFrames(text).some(
    (f) => f.askedAttribute === "price"
  );

  if (framesSayPrice) return true;

  if (convoCtx && isEllipticPriceFollowup(text, convoCtx)) {
    return true;
  }

  return false;
}

function looksLikeDetailIntent(raw: string): boolean {
  return extractQueryFrames(raw).some((f) => f.askedAttribute === "includes");
}

function splitUserQuestions(raw: string): string[] {
  return extractQueryFrames(raw).map((f) => f.raw);
}

function looksMultiQuestion(raw: string): boolean {
  return extractQueryFrames(raw).length >= 2 || String(raw || "").includes("\n");
}

function normalizeCatalogRole(role: string | null | undefined): "primary" | "secondary" {
  const v = String(role || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (
    v === "primary" ||
    v === "servicio principal" ||
    v === "principal" ||
    v === "main"
  ) {
    return "primary";
  }

  if (
    v === "secondary" ||
    v === "complemento" ||
    v === "complemento / extra" ||
    v === "extra" ||
    v === "addon"
  ) {
    return "secondary";
  }

  return "primary";
}

function extractBulletLines(text: string): string[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("•") || line.startsWith("-"));
}

function sameBulletStructure(a: string, b: string): boolean {
  const aBullets = extractBulletLines(a);
  const bBullets = extractBulletLines(b);

  if (aBullets.length !== bBullets.length) return false;

  for (let i = 0; i < aBullets.length; i++) {
    if (aBullets[i] !== bBullets[i]) return false;
  }

  return true;
}

export async function runFastpath(args: RunFastpathArgs): Promise<FastpathResult> {
  const {
    pool,
    tenantId,
    canal,
    idiomaDestino,
    userInput,
    inBooking,
    convoCtx,
    infoClave,
    promptBase,
    detectedIntent,
    catalogReferenceClassification,
    maxDisambiguationOptions = 5,
    lastServiceTtlMs = 60 * 60 * 1000,
  } = args;

  const q = userInput.toLowerCase().trim();

  if (inBooking) return { handled: false };

  const intentOut = (detectedIntent || "").trim() || null;

  const catalogReferenceKind =
    catalogReferenceClassification?.kind ?? "none";

  const isCatalogOverviewTurn =
    catalogReferenceKind === "catalog_overview";

  const isCatalogFamilyTurn =
    catalogReferenceKind === "catalog_family";

  const isEntitySpecificTurn =
    catalogReferenceKind === "entity_specific";

  const isVariantSpecificTurn =
    catalogReferenceKind === "variant_specific";

  const isReferentialFollowupTurn =
    catalogReferenceKind === "referential_followup";

  // ===============================
  // ✅ MULTI-QUESTION SPLIT + ANSWER
  // Ahora basado en frames neutrales:
  // atributo pedido + entidad referida + modificadores
  // ===============================
  {
    const frames = extractQueryFrames(userInput);

    if (frames.length >= 2) {
      const subReplies: string[] = [];
      const seen = new Set<string>();

      for (const frame of frames.slice(0, 2)) {
        const part = frame.raw;
        const partNorm = normalizeText(part);
        if (!partNorm || seen.has(partNorm)) continue;
        seen.add(partNorm);

        const targetText = frame.referencedEntityText || part;
        console.log("[MULTIQ][PRICE] frame input", {
          raw: frame.raw,
          referencedEntityText: frame.referencedEntityText,
          targetText,
          askedAttribute: frame.askedAttribute,
        });

        // =========================================================
        // 1) PREGUNTA DE PRECIO
        // =========================================================
        if (frame.askedAttribute === "price") {
          const { rows } = await pool.query<{
            service_id: string;
            service_name: string;
            min_price: number | string | null;
            max_price: number | string | null;
            parent_service_id: string | null;
            category: string | null;
            catalog_role: string | null;
          }>(`
            WITH variant_prices AS (
              SELECT
                s.id AS service_id,
                s.name AS service_name,
                s.parent_service_id,
                s.category,
                s.catalog_role,
                MIN(v.price)::numeric AS min_price,
                MAX(v.price)::numeric AS max_price
              FROM services s
              JOIN service_variants v
                ON v.service_id = s.id
              AND v.active = true
              WHERE s.tenant_id = $1
                AND s.active = true
                AND v.price IS NOT NULL
              GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
            ),
            base_prices AS (
              SELECT
                s.id AS service_id,
                s.name AS service_name,
                s.parent_service_id,
                s.category,
                s.catalog_role,
                MIN(s.price_base)::numeric AS min_price,
                MAX(s.price_base)::numeric AS max_price
              FROM services s
              WHERE s.tenant_id = $1
                AND s.active = true
                AND s.price_base IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM service_variants v
                  WHERE v.service_id = s.id
                    AND v.active = true
                    AND v.price IS NOT NULL
                )
              GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
            )
            SELECT
              service_id,
              service_name,
              min_price,
              max_price,
              parent_service_id,
              category,
              catalog_role
            FROM (
              SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
              UNION ALL
              SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
            ) x
            ORDER BY
              CASE
                WHEN COALESCE(catalog_role, 'primary') = 'primary' THEN 0
                ELSE 1
              END,
              min_price ASC NULLS LAST,
              service_name ASC
          `, [tenantId]);

          const targetMatches = await resolveServiceMatchesFromText(
            pool,
            tenantId,
            targetText,
            {
              minScore: 0.3,
              maxResults: 6,
              relativeWindow: 0.20,
            }
          );

          const top1 = targetMatches[0] || null;
          const top2 = targetMatches[1] || null;

          function localTokens(raw: string): string[] {
            return normalizeText(String(raw || ""))
              .replace(/[^a-z0-9\s]/g, " ")
              .split(/\s+/)
              .map((x) => x.trim())
              .filter(Boolean);
          }

          const NOISE_TOKENS = new Set([
            "de","del","la","el","los","las","un","una","unos","unas",
            "para","por","en","y","o","u","a","que","q","este","esta",
            "ese","esa","esto","eso","le","lo","al","como","con","sin",
            "sobre","mi","tu","su","me","te","se",
            "the","a","an","and","or","to","for","in","of","what","does",
            "do","is","are","with","without","about","my","your","their",
            "me","you","it",
            "precio","precios","cuanto","cuanta","cuánto","cuánta",
            "cuesta","cuestan","vale","valen","costo","costos",
            "mensual","mensuales","mes","meses","mensualidad","desde",
            "price","prices","pricing","cost","costs","how","much",
            "monthly","month","months","from","starting","starts",
            "what","which","quiero","quieres","want","looking"
          ]);

          const queryTokens = localTokens(targetText).filter((t) => !NOISE_TOKENS.has(t));
          const top1Tokens = top1 ? localTokens(String(top1.name || "")) : [];
          const top2Tokens = top2 ? localTokens(String(top2.name || "")) : [];

          const top1MeaningHits = queryTokens.filter((t) => top1Tokens.includes(t)).length;
          const top2MeaningHits = queryTokens.filter((t) => top2Tokens.includes(t)).length;

          const scoreGap =
            top1 && top2
              ? Number(top1.score || 0) - Number(top2.score || 0)
              : top1
              ? Number(top1.score || 0)
              : 0;

          const targetHit: any =
            top1 &&
            (
              targetMatches.length === 1 ||
              top1MeaningHits > top2MeaningHits ||
              (top1MeaningHits > 0 && scoreGap >= 0.05)
            )
              ? top1
              : null;

          console.log("[MULTIQ][PRICE] resolve attempt", {
            part,
            targetText,
            queryTokens,
            targetMatches,
            top1: top1
              ? {
                  id: top1.id,
                  name: top1.name,
                  score: top1.score,
                  meaningHits: top1MeaningHits,
                }
              : null,
            top2: top2
              ? {
                  id: top2.id,
                  name: top2.name,
                  score: top2.score,
                  meaningHits: top2MeaningHits,
                }
              : null,
            scoreGap,
            targetHit: targetHit
              ? {
                  serviceId: targetHit.serviceId || targetHit.id,
                  serviceName: targetHit.serviceName || targetHit.name,
                }
              : null,
          });

          if (!targetHit && targetMatches.length >= 2) {
            const { rows: allPriceRows } = await pool.query<{
              service_id: string;
              service_name: string;
              min_price: number | string | null;
              max_price: number | string | null;
            }>(`
              WITH variant_prices AS (
                SELECT
                  s.id AS service_id,
                  s.name AS service_name,
                  MIN(v.price)::numeric AS min_price,
                  MAX(v.price)::numeric AS max_price
                FROM services s
                JOIN service_variants v
                  ON v.service_id = s.id
                 AND v.active = true
                WHERE s.tenant_id = $1
                  AND s.active = true
                  AND v.price IS NOT NULL
                GROUP BY s.id, s.name
              ),
              base_prices AS (
                SELECT
                  s.id AS service_id,
                  s.name AS service_name,
                  MIN(s.price_base)::numeric AS min_price,
                  MAX(s.price_base)::numeric AS max_price
                FROM services s
                WHERE s.tenant_id = $1
                  AND s.active = true
                  AND s.price_base IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM service_variants v
                    WHERE v.service_id = s.id
                      AND v.active = true
                      AND v.price IS NOT NULL
                  )
                GROUP BY s.id, s.name
              )
              SELECT service_id, service_name, min_price, max_price
              FROM (
                SELECT service_id, service_name, min_price, max_price FROM variant_prices
                UNION ALL
                SELECT service_id, service_name, min_price, max_price FROM base_prices
              ) x
            `, [tenantId]);

            const matchedPriceLines = targetMatches
              .map((m) => {
                const row = allPriceRows.find((r) => String(r.service_id) === String(m.id));
                if (!row) return null;

                const min = row.min_price === null ? null : Number(row.min_price);
                const max = row.max_price === null ? null : Number(row.max_price);

                let priceText =
                  idiomaDestino === "en" ? "price available" : "precio disponible";

                if (Number.isFinite(min) && Number.isFinite(max)) {
                  priceText =
                    min === max
                      ? `$${min}`
                      : `${idiomaDestino === "en" ? "from" : "desde"} $${min}`;
                }

                return `• ${row.service_name}: ${priceText}`;
              })
              .filter(Boolean) as string[];

            if (matchedPriceLines.length) {
              subReplies.push(matchedPriceLines.join("\n"));
              continue;
            }
          }

          if (targetHit) {
            const targetServiceId = String(targetHit.serviceId || targetHit.id || "");
            const targetServiceName = String(
              targetHit.serviceName || targetHit.name || ""
            ).trim();

            const { rows: variants } = await pool.query<any>(
              `
              SELECT
                id,
                variant_name,
                description,
                variant_url,
                price,
                currency
              FROM service_variants
              WHERE service_id = $1
                AND active = true
              ORDER BY created_at ASC, id ASC
              `,
              [targetServiceId]
            );

            let chosenVariant: any = null;

            if (variants.length > 0) {
              const matchedVariant = bestNameMatch(
                part,
                variants.map((v: any) => ({
                  id: String(v.id),
                  name: String(v.variant_name || "").trim(),
                  url: v.variant_url ? String(v.variant_url).trim() : null,
                }))
              ) as any;

              if (matchedVariant?.id) {
                chosenVariant = variants.find(
                  (v: any) => String(v.id) === String(matchedVariant.id)
                );
              }
            }

            if (chosenVariant) {
              const priceNum =
                chosenVariant.price === null ||
                chosenVariant.price === undefined ||
                chosenVariant.price === ""
                  ? null
                  : Number(chosenVariant.price);

              const baseName = targetServiceName || "";
              const variantName = String(chosenVariant.variant_name || "").trim();
              const link = chosenVariant.variant_url
                ? String(chosenVariant.variant_url).trim()
                : null;

              let block =
                idiomaDestino === "en"
                  ? `• ${baseName} — ${variantName}: ${
                      Number.isFinite(priceNum) ? `$${priceNum}` : "price available"
                    }`
                  : `• ${baseName} — ${variantName}: ${
                      Number.isFinite(priceNum) ? `$${priceNum}` : "precio disponible"
                    }`;

              if (link) {
                block += `\n  Link: ${link}`;
              }

              subReplies.push(block);
              continue;
            }

            if (variants.length > 0) {
              const lines = variants
                .map((v: any) => {
                  const numPrice =
                    v.price === null || v.price === undefined || v.price === ""
                      ? NaN
                      : Number(v.price);
                  const label = String(v.variant_name || "").trim();

                  return Number.isFinite(numPrice)
                    ? `• ${targetServiceName} — ${label}: $${numPrice}`
                    : `• ${targetServiceName} — ${label}`;
                })
                .slice(0, 4);

              if (lines.length) {
                subReplies.push(lines.join("\n"));
                continue;
              }
            }

            const row = rows.find(
              (r) =>
                normalizeText(String(r.service_name || "")) ===
                normalizeText(targetServiceName)
            );

            if (row) {
              const min = row.min_price === null ? null : Number(row.min_price);
              const max = row.max_price === null ? null : Number(row.max_price);

              let priceText =
                idiomaDestino === "en" ? "price available" : "precio disponible";

              if (Number.isFinite(min) && Number.isFinite(max)) {
                priceText =
                  min === max
                    ? `$${min}`
                    : `${idiomaDestino === "en" ? "from" : "desde"} $${min}`;
              }

              subReplies.push(`• ${targetServiceName}: ${priceText}`);
              continue;
            }
          }

          const compact = renderGenericPriceSummaryReply({
            lang: idiomaDestino,
            rows: rows.slice(0, 5),
          });
          subReplies.push(stripLinkSentences(compact));
          continue;
        }

        // =========================================================
        // 2) PREGUNTA DE DETALLE / INCLUDES
        // =========================================================
        if (frame.askedAttribute === "includes") {
          let hit: any = await resolveServiceIdFromText(pool, tenantId, targetText, {
            mode: "loose",
          });

          if (hit) {
            const serviceId = String(hit.serviceId || hit.id || "");
            const serviceName = String(hit.serviceName || hit.name || "").trim();

            const { rows: variants } = await pool.query<any>(
              `
              SELECT
                id,
                variant_name,
                description,
                variant_url,
                price,
                currency
              FROM service_variants
              WHERE service_id = $1
                AND active = true
              ORDER BY created_at ASC, id ASC
              `,
              [serviceId]
            );

            if (variants.length > 0) {
              const matchedVariant = bestNameMatch(
                part,
                variants.map((v: any) => ({
                  id: String(v.id),
                  name: String(v.variant_name || "").trim(),
                  url: v.variant_url ? String(v.variant_url).trim() : null,
                }))
              ) as any;

              if (matchedVariant?.id) {
                const chosen = variants.find(
                  (v: any) => String(v.id) === String(matchedVariant.id)
                );

                if (chosen) {
                  const descSource = (chosen.description || "").trim();
                  const link = chosen.variant_url
                    ? String(chosen.variant_url).trim()
                    : null;

                  let block = `• ${serviceName} — ${String(chosen.variant_name || "").trim()}`;
                  if (descSource) block += `\n  ${descSource}`;
                  if (link) block += `\n  Link: ${link}`;

                  subReplies.push(block);
                  continue;
                }
              }
            }

            const {
              rows: [service],
            } = await pool.query<any>(
              `
              SELECT name, description, service_url
              FROM services
              WHERE id = $1
              `,
              [serviceId]
            );

            const desc = String(service?.description || "").trim();
            const link = service?.service_url ? String(service.service_url).trim() : null;

            let block = `• ${serviceName}`;
            if (desc) block += `\n  ${desc}`;
            if (link) block += `\n  Link: ${link}`;

            subReplies.push(block);
            continue;
          }
        }
      }

      if (subReplies.length >= 2) {
        const intro =
          idiomaDestino === "en"
            ? "Here’s what I found:"
            : "Esto fue lo que consegui 😊";

        return {
          handled: true,
          reply: `${intro}\n\n${subReplies.join("\n\n")}`,
          source: "service_list_db",
          intent: intentOut || "info_servicio",
        };
      }
    }
  }

  // ===============================
  // ✅ Dismiss Fastpath
  // ===============================
  {
    const hasFastpathContext =
      (Array.isArray(convoCtx?.last_plan_list) && convoCtx.last_plan_list.length > 0) ||
      (Array.isArray(convoCtx?.last_package_list) && convoCtx.last_package_list.length > 0) ||
      !!convoCtx?.last_service_id ||
      !!convoCtx?.pending_price_lookup ||
      !!convoCtx?.pending_link_lookup;

    const explicitNoThanks =
      /\b(no gracias|no, gracias|no por ahora|no quiero|no necesito|estoy bien|todo bien)\b/i.test(q) ||
      /\b(no thanks|no, thanks|i'm good|im good|all good|not now)\b/i.test(q);

    const plainThanks = /\b(gracias|thanks)\b/i.test(q);

    const isFastpathDismiss = explicitNoThanks || (plainThanks && hasFastpathContext);

    if (isFastpathDismiss) {
      const now = Date.now();

      const ctxPatch: Partial<FastpathCtx> = {
        last_plan_list: undefined,
        last_plan_list_at: undefined,
        last_package_list: undefined,
        last_package_list_at: undefined,
        last_list_kind: undefined,
        last_list_kind_at: undefined,

        last_service_id: null,
        last_service_name: null,
        last_service_at: null,

        pending_price_lookup: undefined,
        pending_price_at: undefined,

        pending_link_lookup: undefined,
        pending_link_at: undefined,
        pending_link_options: undefined,

        last_price_option_label: undefined,
        last_price_option_at: undefined,

        last_selected_kind: null,
        last_selected_id: null,
        last_selected_name: null,
        last_selected_at: null,

        // limpia también histórico de catálogo
        last_catalog_plans: undefined,
        last_catalog_at: undefined,

        last_bot_action: "fastpath_dismiss",
        last_bot_action_at: now,
      };

      const reply =
        idiomaDestino === "en"
          ? "Perfect, if you need anything else just let me know 😊"
          : "Perfecto 😊 si necesitas algo más, aquí estoy para ayudarte.";

      return {
        handled: true,
        reply,
        source: "fastpath_dismiss",
        intent: intentOut || "fastpath_dismiss",
        ctxPatch,
      };
    }
  }

  // ===============================
  // ✅ INFO GENERAL OVERVIEW
  // ===============================
  if (intentOut === "info_general") {
    const ctxPatch: any = {
      last_list_kind: null,
      last_list_kind_at: null,
      last_plan_list: null,
      last_plan_list_at: null,
      last_package_list: null,
      last_package_list_at: null,
    };

    const reply = await renderInfoGeneralOverview({
      pool,
      tenantId,
      lang: idiomaDestino,
    });

    return {
      handled: true,
      source: "service_list_db",
      intent: intentOut,
      reply,
      ctxPatch,
    };
  }

  // ===============================
  // ✅ RESOLVER SELECCIÓN PENDIENTE DE LINK/VARIANTE
  // PRIORIDAD MÁXIMA: si ya preguntamos "Por Mes / Autopago",
  // el siguiente "1", "2" o nombre debe resolverse AQUÍ,
  // sin volver a pasar por PICK FROM LAST LIST ni por resolveBestLinkForService.
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const pendingLinkLookup = Boolean(convoCtx?.pending_link_lookup);
    const pendingLinkAt = Number(convoCtx?.pending_link_at || 0);
    const pendingLinkOptions = Array.isArray(convoCtx?.pending_link_options)
      ? convoCtx.pending_link_options
      : [];

    const pendingFresh =
      pendingLinkLookup &&
      pendingLinkOptions.length > 0 &&
      Number.isFinite(pendingLinkAt) &&
      pendingLinkAt > 0 &&
      Date.now() - pendingLinkAt <= ttlMs;

    if (pendingFresh) {
      const msgNorm = normalizeText(userInput);

      const idx = (() => {
        const m = String(userInput || "").trim().match(/^([1-9])$/);
        return m ? Number(m[1]) : null;
      })();

      let pickedOption: { label: string; url: string } | null = null;

      // 1) Selección numérica directa
      if (idx != null) {
        const i = idx - 1;
        if (i >= 0 && i < pendingLinkOptions.length) {
          pickedOption = pendingLinkOptions[i];
        }
      }

      // 2) Selección por nombre
      if (!pickedOption) {
        const byName = bestNameMatch(
          userInput,
          pendingLinkOptions.map((o: any) => ({
            name: String(o.label || "").trim(),
            url: String(o.url || "").trim(),
          }))
        ) as any;

        if (byName?.name) {
          pickedOption = pendingLinkOptions.find(
            (o: any) => normalizeText(String(o.label || "")) === normalizeText(String(byName.name || ""))
          ) || null;
        }
      }

      if (pickedOption?.url) {
        const serviceId = String(convoCtx?.last_service_id || "").trim();
        const baseName = String(convoCtx?.last_service_name || "").trim();
        const optionLabel = String(pickedOption.label || "").trim();
        const finalUrl = String(pickedOption.url || "").trim();

        let variantId: string | null = null;
        let variantName = optionLabel;
        let variantDescription = "";
        let serviceDescription = "";

        if (serviceId) {
          const { rows: variantRows } = await pool.query<any>(
            `
            SELECT
              v.id,
              v.variant_name,
              v.description,
              v.variant_url,
              s.description AS service_description
            FROM service_variants v
            JOIN services s
              ON s.id = v.service_id
            WHERE v.service_id = $1
              AND v.active = true
              AND (
                lower(trim(coalesce(v.variant_url, ''))) = lower(trim($2))
                OR lower(trim(coalesce(v.variant_name, ''))) = lower(trim($3))
              )
            ORDER BY
              CASE
                WHEN lower(trim(coalesce(v.variant_url, ''))) = lower(trim($2)) THEN 0
                ELSE 1
              END,
              v.created_at ASC,
              v.id ASC
            LIMIT 1
            `,
            [serviceId, finalUrl, optionLabel]
          );

          const variant = variantRows[0];

          if (variant) {
            variantId = String(variant.id || "").trim() || null;
            variantName = String(variant.variant_name || optionLabel || "").trim();
            serviceDescription = String(variant.service_description || "").trim();
            variantDescription = String(variant.description || "").trim() || serviceDescription;
          } else {
            const { rows: serviceRows } = await pool.query<any>(
              `
              SELECT description
              FROM services
              WHERE id = $1
              LIMIT 1
              `,
              [serviceId]
            );

            serviceDescription = String(serviceRows[0]?.description || "").trim();
            variantDescription = serviceDescription;
          }
        }

        const title =
          baseName && variantName
            ? `${baseName} — ${variantName}`
            : baseName || variantName || "";

        const bullets =
          variantDescription
            ? variantDescription
                .split(/\r?\n/)
                .map((l: string) => l.trim())
                .filter((l: string) => l.length > 0)
                .map((l: string) => `• ${l}`)
                .join("\n")
            : "";

        const intro =
          idiomaDestino === "en"
            ? "Perfect 😊"
            : "Perfecto 😊";

        const linkLabel =
          idiomaDestino === "en"
            ? "Here’s the link:"
            : "Aquí tienes el link:";

        const outro =
          idiomaDestino === "en"
            ? "If you need anything else, just let me know 😊"
            : "Si necesitas algo más, avísame 😊";

        const reply =
          idiomaDestino === "en"
            ? `${intro}\n\n${title}${bullets ? `\n\n${bullets}` : ""}\n\n${linkLabel}\n${finalUrl}\n\n${outro}`
            : `${intro}\n\n${title}${bullets ? `\n\n${bullets}` : ""}\n\n${linkLabel}\n${finalUrl}\n\n${outro}`;

        console.log("[FASTPATH][PENDING_LINK_SELECTION][VARIANT_REPLY]", {
          userInput,
          serviceId,
          baseName,
          optionLabel,
          variantName,
          hasVariantDescription: !!variantDescription,
          finalUrl,
        });

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || "seleccion",
          ctxPatch: {
            pending_link_lookup: undefined,
            pending_link_at: undefined,
            pending_link_options: undefined,

            last_price_option_label: optionLabel || null,
            last_price_option_at: Date.now(),

            last_variant_id: variantId,
            last_variant_name: variantName || null,
            last_variant_url: finalUrl || null,
            last_variant_at: Date.now(),

            last_bot_action: "sent_link_option",
            last_bot_action_at: Date.now(),
          } as Partial<FastpathCtx>,
        };
      }
    }
  }

  // ===============================
  // ✅ PICK FROM LAST LIST
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const planList = Array.isArray(convoCtx?.last_plan_list) ? convoCtx.last_plan_list : [];
    const planAtRaw = (convoCtx as any)?.last_plan_list_at;
    const planAt = Number(planAtRaw);
    const planAtOk = Number.isFinite(planAt) && planAt > 0;
    const planFresh = planList.length > 0 && (!planAtOk || Date.now() - planAt <= ttlMs);

    const pkgList = Array.isArray(convoCtx?.last_package_list) ? convoCtx.last_package_list : [];
    const pkgAtRaw = (convoCtx as any)?.last_package_list_at;
    const pkgAt = Number(pkgAtRaw);
    const pkgAtOk = Number.isFinite(pkgAt) && pkgAt > 0;
    const pkgFresh = pkgList.length > 0 && (!pkgAtOk || Date.now() - pkgAt <= ttlMs);

    const kind = (convoCtx?.last_list_kind as any) || null;
    const kindAtRaw = (convoCtx as any)?.last_list_kind_at;
    const kindAt = Number(kindAtRaw);
    const kindAtOk = Number.isFinite(kindAt) && kindAt > 0;
    const kindFresh = Boolean(kind) && (!kindAtOk || Date.now() - kindAt <= ttlMs);

    const healPatch: Partial<FastpathCtx> = {};

    if (planList.length > 0 && !planAtOk) healPatch.last_plan_list_at = Date.now();
    if (pkgList.length > 0 && !pkgAtOk) healPatch.last_package_list_at = Date.now();
    if (kind && !kindAtOk) healPatch.last_list_kind_at = Date.now();

    if (planFresh || pkgFresh) {
      if (isTrialQuery(userInput)) {
        console.log("🧪 PICK SKIP — trial/demo query, dejar a otras reglas manejarlo");
      } else {
        const idx = (() => {
          const t = String(userInput || "").trim();
          const m = t.match(/^([1-9])$/);
          return m ? Number(m[1]) : null;
        })();

        const msgNorm = normalizeText(userInput);

        const mentionsPlanFromList =
          planFresh &&
          planList.some((p: any) => {
            const name = String(p?.name ?? p?.label ?? "").trim();
            if (!name) return false;
            const nameNorm = normalizeText(name);
            return !!nameNorm && msgNorm.includes(nameNorm);
          });

        const mentionsPackageFromList =
          pkgFresh &&
          pkgList.some((p: any) => {
            const name = String(p?.name ?? p?.label ?? "").trim();
            if (!name) return false;
            const nameNorm = normalizeText(name);
            return !!nameNorm && msgNorm.includes(nameNorm);
          });

        const candidateFromPlans = planFresh ? bestNameMatch(userInput, planList as any) : null;
        const candidateFromPackages = pkgFresh ? bestNameMatch(userInput, pkgList as any) : null;

        if (!candidateFromPlans && !candidateFromPackages && idx == null) {
          console.log("🧪 PICK SKIP — no numeric choice or fuzzy match in msg");
        } else {
          const tryPick = (
            list: Array<{ id: string; name: string; url: string | null }>,
            kind: "plan" | "package"
          ) => {
            let picked: { id: string; name: string; url: string | null } | null = null;

            if (idx != null) {
              const i = idx - 1;
              if (i >= 0 && i < list.length) picked = list[i];
            }
            if (!picked) picked = bestNameMatch(userInput, list as any) as any;
            return picked ? { ...picked, kind } : null;
          };

          let picked: { id: string; name: string; url: string | null; kind: "plan" | "package" } | null =
            null;

          if (kindFresh && kind === "package") {
            if (pkgFresh) picked = tryPick(pkgList, "package");
            if (!picked && planFresh) picked = tryPick(planList, "plan");
          } else {
            if (planFresh) picked = tryPick(planList, "plan");
            if (!picked && pkgFresh) picked = tryPick(pkgList, "package");
          }

          if (picked) {
            const rawPickedId = String(picked.id || "");
            const parts = rawPickedId.split("::");
            const pickedServiceId = parts[0] || rawPickedId;
            const pickedOptionLabel = parts.length > 1 ? parts.slice(1).join("::") : null;

            const basePatch: Partial<FastpathCtx> = {
              last_selected_kind: picked.kind,
              last_selected_id: picked.id,
              last_selected_name: picked.name,
              last_selected_at: Date.now(),

              last_service_id: pickedServiceId,
              last_service_name: picked.name,
              last_service_at: Date.now(),

              last_price_option_label: pickedOptionLabel,
              last_price_option_at: Date.now(),
            };

            const pendingLinkOptions = Array.isArray((convoCtx as any)?.pending_link_options)
              ? (convoCtx as any).pending_link_options
              : [];

            const pendingLinkLookupActive =
              Boolean((convoCtx as any)?.pending_link_lookup) &&
              pendingLinkOptions.length > 0;

            const numericChoice =
              idx != null && idx >= 1 && idx <= pendingLinkOptions.length
                ? pendingLinkOptions[idx - 1]
                : null;

            const namedChoice =
              !numericChoice && pendingLinkLookupActive
                ? (bestNameMatch(userInput, pendingLinkOptions as any) as any)
                : null;

            const directPendingChoice = numericChoice || namedChoice;

            let finalUrl: string | null =
              directPendingChoice?.url
                ? String(directPendingChoice.url).trim()
                : picked.url
                ? String(picked.url).trim()
                : null;

            if (directPendingChoice?.url) {
              const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(
                () => null
              );

              const baseName =
                String(convoCtx?.last_service_name || "") || String(picked.name || "");
              const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;
              const infoText = d?.text ? String(d.text).trim() : "";

              const reply =
                idiomaDestino === "en"
                  ? `${title}${infoText ? `\n\n${infoText}` : ""}\n\nHere’s the link:\n${finalUrl}`
                  : `${title}${infoText ? `\n\n${infoText}` : ""}\n\nAquí está el link:\n${finalUrl}`;

              return {
                handled: true,
                reply,
                source: "service_list_db",
                intent: intentOut || "seleccion",
                ctxPatch: {
                  ...basePatch,
                  pending_link_lookup: undefined,
                  pending_link_at: undefined,
                  pending_link_options: undefined,
                  last_price_option_label: String(directPendingChoice.label || "").trim() || null,
                  last_price_option_at: Date.now(),
                  last_bot_action: "sent_link_option",
                  last_bot_action_at: Date.now(),
                } as any,
              };
            }

            if (!finalUrl) {
              const linkPick = await resolveBestLinkForService({
                pool,
                tenantId,
                serviceId: pickedServiceId,
                userText: userInput,
              });

              if (linkPick.ok) {
                finalUrl = linkPick.url;
              } else if (linkPick.reason === "ambiguous") {
                const labels = linkPick.options
                  .slice(0, 3)
                  .map((o) => o.label)
                  .filter(Boolean);

                const optionsList = linkPick.options
                  .slice(0, 3)
                  .map((o, i) => `• ${i + 1}) ${String(o.label || "").trim()}`)
                  .join("\n");

                const q =
                  idiomaDestino === "en"
                    ? `Just to make sure 😊 are you referring to:\n\n${optionsList}\n\nYou can reply with the number or the name.`
                    : `Solo para asegurarme 😊 ¿te refieres a:\n\n${optionsList}\n\nPuedes responder con el número o el nombre.`;

                return {
                  handled: true,
                  reply: q,
                  source: "service_list_db",
                  intent: intentOut || "seleccion",
                  ctxPatch: {
                    ...healPatch,
                    ...basePatch,
                    pending_link_lookup: true,
                    pending_link_at: Date.now(),
                    pending_link_options: linkPick.options,
                    last_bot_action: "asked_link_option",
                    last_bot_action_at: Date.now(),
                  } as any,
                };
              }
            }

            const d = await getServiceDetailsText(tenantId, pickedServiceId, userInput).catch(
              () => null
            );

            const baseName = String(convoCtx?.last_service_name || "") || String(picked.name || "");
            const title = d?.titleSuffix ? `${baseName} — ${d.titleSuffix}` : baseName;

            const infoText = d?.text ? String(d.text).trim() : "";

            if (!finalUrl) {
              const linkPick2 = await resolveBestLinkForService({
                pool,
                tenantId,
                serviceId: pickedServiceId,
                userText: userInput,
              }).catch(() => null);

              if (linkPick2?.ok) finalUrl = linkPick2.url;
            }

            const reply =
              idiomaDestino === "en"
                ? `${title}${infoText ? `\n\n${infoText}` : ""}${
                    finalUrl ? `\n\nHere’s the link:\n${finalUrl}` : ""
                  }`
                : `${title}${infoText ? `\n\n${infoText}` : ""}${
                    finalUrl ? `\n\nAquí está el link:\n${finalUrl}` : ""
                  }`;

            return {
              handled: true,
              reply,
              source: "service_list_db",
              intent: intentOut || "seleccion",
              ctxPatch: {
                ...basePatch,
                pending_link_lookup: undefined,
                pending_link_at: undefined,
                pending_link_options: undefined,
                last_bot_action: "sent_details",
                last_bot_action_at: Date.now(),
              } as any,
            };
          }
        }
      }
    }
  }

  // ===============================
  // ✅ ANTI-LOOP PENDING LINK
  // ===============================
  {
    const ttlMs = 5 * 60 * 1000;

    const pending = Boolean(convoCtx?.pending_link_lookup);
    const pendingAt = Number(convoCtx?.pending_link_at || 0);
    const pendingOptions = Array.isArray(convoCtx?.pending_link_options)
      ? convoCtx.pending_link_options
      : [];

    const pendingFresh =
      pending && pendingAt > 0 && Date.now() - pendingAt <= ttlMs && pendingOptions.length > 0;

    if (pending && !pendingFresh) {
      return {
        handled: false,
        ctxPatch: {
          pending_link_lookup: undefined,
          pending_link_at: undefined,
          pending_link_options: undefined,
        } as any,
      };
    }

    if (pendingFresh) {
      const normLocal = (s: string) =>
        String(s || "")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .trim();

      const tNorm = normLocal(userInput);

      const looksLikeCancel =
        /\b(no|no\s+gracias|gracias|thanks|cancelar|olvidalo|olvidalo|stop)\b/.test(tNorm);

      const idx = (() => {
        const m = tNorm.match(/^([1-9])$/);
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
      })();

      const looksLikeOptionByIndex =
        idx != null && idx >= 1 && idx <= Math.min(9, pendingOptions.length);

      const labelWordHit = pendingOptions.some((o: any) => {
        const labelNorm = normLocal(o?.label || "");
        if (!labelNorm) return false;
        const words = labelNorm.split(/\s+/).filter((w) => w.length >= 3);
        return words.some((w) => tNorm.includes(w));
      });

      const looksLikeOptionAnswer = looksLikeOptionByIndex || labelWordHit;

      if (looksLikeCancel || !looksLikeOptionAnswer) {
        return {
          handled: false,
          ctxPatch: {
            pending_link_lookup: undefined,
            pending_link_at: undefined,
            pending_link_options: undefined,
          } as any,
        };
      }
    }
  }

  // ===============================
  // ✅ FREE OFFER
  // ===============================
  {
    const wantsFreeOffer = isFreeOfferQuestion(userInput);

    if (wantsFreeOffer) {
      const { rows } = await pool.query(
        `
        SELECT s.id, s.name, s.service_url
        FROM services s
        WHERE s.tenant_id = $1
          AND s.active = true
          AND COALESCE(s.price_base, 0) <= 0
          AND s.service_url IS NOT NULL
          AND length(trim(s.service_url)) > 0
        ORDER BY s.updated_at DESC NULLS LAST, s.created_at DESC
        LIMIT 10
        `,
        [tenantId]
      );

      const items = (rows || [])
        .map((r: any) => ({
          id: String(r.id),
          name: String(r.name || "").trim(),
          url: r.service_url ? String(r.service_url).trim() : null,
        }))
        .filter((x) => x.name && x.url);

      if (!items.length) {
        const msg =
          idiomaDestino === "en"
            ? "Yes — we can help with a free/trial option 😊 What exactly are you looking for?"
            : "Sí — podemos ayudarte con una opción gratis/de prueba 😊 ¿Qué estás buscando exactamente?";
        return { handled: true, reply: msg, source: "service_list_db", intent: "free_offer" };
      }

      if (items.length === 1) {
        const one = items[0];
        return {
          handled: true,
          reply: `${one.name}\n${one.url}`,
          source: "service_list_db",
          intent: "free_offer",
          ctxPatch: {
            last_service_id: one.id,
            last_service_name: one.name,
            last_service_at: Date.now(),
          },
        };
      }

      const reply = renderFreeOfferList({
        lang: idiomaDestino,
        items: items.map((x) => ({ name: x.name })),
      });

      return {
        handled: true,
        reply,
        source: "service_list_db",
        intent: "free_offer",
        ctxPatch: {
          last_plan_list: items.map((x) => ({ id: x.id, name: x.name, url: x.url })),
          last_plan_list_at: Date.now(),
          last_list_kind: "plan",
          last_list_kind_at: Date.now(),
        },
      };
    }
  }

  // ===============================
  // ✅ INTEREST -> LINK
  // ===============================
  {
    const t = String(userInput || "").trim();
    const tNorm = normalizeText(userInput);

    const wantsLink =
      /\b(link|enlace|url|web|website|sitio|pagina|página|comprar|buy|pagar|checkout)\b/i.test(
        tNorm
      );

    const pending = Boolean(convoCtx?.pending_link_lookup);

    const lastAct = String(convoCtx?.last_bot_action || "");
    const lastActAt = Number(convoCtx?.last_bot_action_at || 0);
    const justSentDetails =
      lastAct === "sent_details" && lastActAt > 0 && Date.now() - lastActAt < 2 * 60 * 1000;

    if (justSentDetails && !pending) {
      return { handled: false };
    }

    if ((wantsLink || pending) && convoCtx?.last_service_id) {
      const pick = await resolveBestLinkForService({
        pool,
        tenantId,
        serviceId: String(convoCtx.last_service_id),
        userText: userInput,
      });

      if (pick.ok) {
        const serviceId = String(convoCtx.last_service_id);
        const baseName = String(convoCtx?.last_service_name || "").trim();

        const d = await getServiceDetailsText(tenantId, serviceId, userInput).catch(() => null);

        const title = d?.titleSuffix
          ? `${baseName || ""}${baseName ? " — " : ""}${String(d.titleSuffix).trim()}`
          : baseName;

        const infoText = d?.text ? String(d.text).trim() : "";

        const outro =
          idiomaDestino === "en"
            ? "If you need anything else, just let me know 😊"
            : "Si necesitas algo más, déjame saber 😊";

        let reply =
          idiomaDestino === "en"
            ? `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Here it is 😊\n${
                pick.url
              }\n\n${outro}`
            : `${title ? `${title}\n\n` : ""}${infoText ? `${infoText}\n\n` : ""}Aquí lo tienes 😊\n${
                pick.url
              }\n\n${outro}`;

        const variantId =
          (convoCtx as any)?.last_variant_id ? String((convoCtx as any).last_variant_id) : null;

        try {
          const { serviceUrl, variantUrl } = await getServiceAndVariantUrl(
            pool,
            tenantId,
            serviceId,
            variantId
          );

          const finalUrl = variantUrl || serviceUrl;

          if (finalUrl) {
            const linkLine =
              idiomaDestino === "en"
                ? `\n\n👉 You can see all the details or purchase here: ${finalUrl}`
                : `\n\n👉 Puedes ver todos los detalles o comprarlo aquí: ${finalUrl}`;

            reply = `${reply}${linkLine}`;
          }
        } catch (e: any) {
          console.warn("⚠️ runFastpath: no se pudo adjuntar URL de servicio:", e?.message);
        }

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || "link",
          ctxPatch: {
            last_bot_action: "sent_link_with_details",
            last_bot_action_at: Date.now(),
            pending_link_lookup: undefined,
            pending_link_at: undefined,
            pending_link_options: undefined,
          } as any,
        };
      }

      if (!pick.ok && pick.reason === "ambiguous") {
        const labels = pick.options
          .slice(0, 3)
          .map((o) => o.label)
          .filter(Boolean);

        const q =
          idiomaDestino === "en"
            ? `Sure 😊 Which option do you want— ${labels.join(" or ")}?`
            : `Perfecto 😊 ¿Cuál opción quieres— ${labels.join(" o ")}?`;

        return {
          handled: true,
          reply: q,
          source: "service_list_db",
          intent: intentOut || "link",
          ctxPatch: {
            pending_link_lookup: true,
            pending_link_at: Date.now(),
            pending_link_options: pick.options,
          } as any,
        };
      }
    }
  }

  // =========================================================
  // ✅ FOLLOW-UP ROUTER
  // =========================================================
  {
    const t = String(userInput || "").trim();
    const tLower = t.toLowerCase();

    const isShort =
      t.length > 0 &&
      t.length <= 22 &&
      !t.includes("?") &&
      !/\b(hola|hi|hello|gracias|thanks)\b/i.test(tLower);

    const now = Date.now();

    const ttlMs = 10 * 60 * 1000;

    const fresh = (at: any) => {
      const n = Number(at || 0);
      return Number.isFinite(n) && n > 0 && now - n <= ttlMs;
    };

    const pendingPrice =
      Boolean((convoCtx as any)?.pending_price_lookup) &&
      fresh((convoCtx as any)?.pending_price_at);
    const pendingLink =
      Boolean((convoCtx as any)?.pending_link_lookup) && fresh((convoCtx as any)?.pending_link_at);

    const lastServiceId = String((convoCtx as any)?.last_service_id || "").trim();
    const lastServiceFresh = lastServiceId && fresh((convoCtx as any)?.last_service_at);

    const planList = Array.isArray((convoCtx as any)?.last_plan_list)
      ? (convoCtx as any).last_plan_list
      : [];
    const pkgList = Array.isArray((convoCtx as any)?.last_package_list)
      ? (convoCtx as any).last_package_list
      : [];
    const listFresh =
      (planList.length && fresh((convoCtx as any)?.last_plan_list_at)) ||
      (pkgList.length && fresh((convoCtx as any)?.last_package_list_at));

    if (isShort && pendingLink && Array.isArray((convoCtx as any)?.pending_link_options)) {
      const opts = (convoCtx as any).pending_link_options;
      const pick = bestNameMatch(t, opts.map((o: any) => ({ name: o.label })) as any);

      if (pick?.name) {
        return {
          handled: false,
          ctxPatch: {
            pending_link_lookup: null,
            pending_link_at: null,
            pending_link_options: null,
            last_bot_action: "followup_link_pick",
            last_bot_action_at: now,
          } as any,
        };
      }
    }

    if (isShort && listFresh) {
      // deja que PICK FROM LAST LIST lo maneje
    } else {
      if (isShort && pendingPrice) {
        const pendingTargetText = String((convoCtx as any)?.pending_price_target_text || "").trim();
        const textForResolution = pendingTargetText || t;

        const hit = await resolveServiceIdFromText(pool, tenantId, textForResolution, {
          mode: "loose",
        });

        if (hit?.id) {
          return {
            handled: false,
            ctxPatch: {
              last_service_id: hit.id,
              last_service_name: hit.name,
              last_service_at: now,
              pending_price_lookup: null,
              pending_price_at: null,
              pending_price_target_text: null,
              pending_price_raw_user_text: null,
              last_bot_action: "followup_set_service_for_price",
              last_bot_action_at: now,
            } as any,
          };
        }
      }

      const hasExplicitVariantSelectionContext =
        Boolean(convoCtx?.expectingVariant) &&
        Boolean(convoCtx?.selectedServiceId);

      if (isShort && lastServiceFresh && !hasExplicitVariantSelectionContext) {
        return {
          handled: false,
          ctxPatch: {
            last_price_option_label: t,
            last_price_option_at: now,
            last_bot_action: "followup_option_label",
            last_bot_action_at: now,
          } as any,
        };
      }
    }
  }

  // ===============================
  // ✅ FOLLOW-UP DE VARIANTE DEL MISMO SERVICIO (GENÉRICO / MULTITENANT)
  // Si ya estamos parados en un servicio con variantes y el usuario
  // menciona una variante, responder directo sin relistar.
  // ===============================
  {
    const now = Date.now();
    const ttlMs = 10 * 60 * 1000;

    const lastServiceId = String((convoCtx as any)?.last_service_id || "").trim();
    const lastServiceFresh =
      !!lastServiceId &&
      Number((convoCtx as any)?.last_service_at || 0) > 0 &&
      now - Number((convoCtx as any)?.last_service_at || 0) <= ttlMs;

    const isAwaitingPriceVariantSelection =
      String((convoCtx as any)?.last_bot_action || "") === "asked_price_variant" &&
      Boolean((convoCtx as any)?.expectingVariant) &&
      Array.isArray((convoCtx as any)?.last_variant_options) &&
      (convoCtx as any).last_variant_options.length > 0;

    if (lastServiceFresh && !isAwaitingPriceVariantSelection) {
      const { rows: variants } = await pool.query<any>(
        `
        SELECT
          id,
          variant_name,
          description,
          variant_url,
          price,
          currency
        FROM service_variants
        WHERE service_id = $1
          AND active = true
        ORDER BY created_at ASC, id ASC
        `,
        [lastServiceId]
      );

      if (variants.length > 0) {
        const matchedVariant = bestNameMatch(
          userInput,
          variants.map((v: any) => ({
            id: String(v.id),
            name: String(v.variant_name || "").trim(),
            url: v.variant_url ? String(v.variant_url).trim() : null,
          }))
        ) as any;

        if (matchedVariant?.name) {
          const chosen = variants.find(
            (v: any) => String(v.id) === String(matchedVariant.id)
          );

          if (chosen) {
            const {
              rows: [service],
            } = await pool.query<any>(
              `
              SELECT
                name,
                description,
                service_url
              FROM services
              WHERE id = $1
              `,
              [lastServiceId]
            );

            const descSource = (chosen.description || service?.description || "").trim();
            const link: string | null = chosen.variant_url || service?.service_url || null;

            const bullets: string =
              descSource
                ? descSource
                    .split(/\r?\n/)
                    .map((l: string) => l.trim())
                    .filter((l: string) => l.length > 0)
                    .map((l: string) => `• ${l}`)
                    .join("\n")
                : "";

            const baseName = String(service?.name || "").trim();
            const variantName = String(chosen.variant_name || "").trim();

            const title =
              baseName && variantName
                ? `${baseName} — ${variantName}`
                : baseName || variantName || "";

            let reply =
              idiomaDestino === "en"
                ? `Perfect 😊\n\n${title ? `*${title}*` : ""}${bullets ? ` includes:\n\n${bullets}` : ""}`
                : `Perfecto 😊\n\n${title ? `*${title}*` : ""}${bullets ? ` incluye:\n\n${bullets}` : ""}`;

            if (link) {
              reply +=
                idiomaDestino === "en"
                  ? `\n\nHere you can see more details:\n${link}`
                  : `\n\nAquí puedes ver más detalles:\n${link}`;
            }

            console.log("[FASTPATH-VARIANT-FOLLOWUP] direct variant switch", {
              userInput,
              serviceId: lastServiceId,
              baseName,
              variantName,
              link,
            });

            return {
              handled: true,
              reply,
              source: "service_list_db",
              intent: intentOut || "info_servicio",
              ctxPatch: {
                last_service_id: lastServiceId,
                last_service_name: baseName || null,
                last_service_at: Date.now(),

                last_variant_id: String(chosen.id || ""),
                last_variant_name: variantName || null,
                last_variant_url: link || null,
                last_variant_at: Date.now(),

                last_price_option_label: variantName || null,
                last_price_option_at: Date.now(),
              } as Partial<FastpathCtx>,
            };
          }
        }
      }
    }
  }

  // ===============================
  // ✅ VARIANTES: SEGUNDO TURNO
  // El usuario ya vio las opciones y ahora elige una (1, "autopay", etc.)
  // ===============================
  const msgNorm = normalizeText(userInput);

  const explicitDetailIntentNow = looksLikeDetailIntent(userInput);
  const explicitTargetTokenNow = extractCatalogTargetToken(userInput);

  const isNumericSelection = /^([1-9])$/.test(msgNorm);

  const isNamedVariantSelection =
    msgNorm.length > 0 &&
    msgNorm.length <= 24 &&
    !explicitDetailIntentNow &&
    !/[?¿]/.test(String(userInput || ""));

  const isShortVariantSelection =
    isNumericSelection || isNamedVariantSelection;

  const hasVariantSelectionContext =
    Boolean(convoCtx.expectingVariant) ||
    Boolean(
      convoCtx.selectedServiceId &&
      (
        convoCtx.last_service_id ||
        convoCtx.last_service_name ||
        convoCtx.last_variant_name ||
        convoCtx.last_price_option_label ||
        (Array.isArray(convoCtx.last_catalog_plans) && convoCtx.last_catalog_plans.length > 0) ||
        (Array.isArray(convoCtx.pending_link_options) && convoCtx.pending_link_options.length > 0)
      )
    );

  const shouldSkipVariantSelection =
    explicitDetailIntentNow || !!explicitTargetTokenNow;

  if (
    !shouldSkipVariantSelection &&
    convoCtx.selectedServiceId &&
    hasVariantSelectionContext &&
    isShortVariantSelection
  ) {
    console.log("[VARIANT_SECOND_TURN][ENTRY]", {
      userInput,
      expectingVariant: convoCtx.expectingVariant,
      selectedServiceId: convoCtx.selectedServiceId,
      hasVariantSelectionContext,
      isShortVariantSelection,
      shouldSkipVariantSelection,
    });

    const serviceId = String(convoCtx.selectedServiceId);

    const askedPriceVariant =
      String((convoCtx as any)?.last_bot_action || "") === "asked_price_variant";

    const storedVariantOptions = Array.isArray((convoCtx as any)?.last_variant_options)
      ? (convoCtx as any).last_variant_options
      : [];

    if (askedPriceVariant && storedVariantOptions.length > 0) {
      let chosenOption: any = null;

      const mNum = msgNorm.match(/^([1-9])$/);
      if (mNum) {
        const pickedIndex = Number(mNum[1]);
        chosenOption =
          storedVariantOptions.find((v: any) => Number(v.index) === pickedIndex) || null;
      }

      if (!chosenOption) {
        chosenOption =
          bestNameMatch(
            userInput,
            storedVariantOptions.map((v: any) => ({
              id: String(v.id || ""),
              name: String(v.name || "").trim(),
              url: v.url ? String(v.url).trim() : null,
            }))
          ) || null;
      }

      if (chosenOption?.id) {
        const {
          rows: [chosenRow],
        } = await pool.query<any>(
          `
          SELECT
            v.id,
            v.variant_name,
            v.description,
            v.variant_url,
            v.price,
            v.currency,
            s.name AS service_name,
            s.service_url
          FROM service_variants v
          JOIN services s
            ON s.id = v.service_id
          WHERE v.id = $1
            AND v.active = true
          LIMIT 1
          `,
          [String(chosenOption.id)]
        );

        if (chosenRow) {
          const baseName = String(chosenRow.service_name || "").trim();
          const variantName = String(chosenRow.variant_name || "").trim();
          const priceNum =
            chosenRow.price === null || chosenRow.price === undefined || chosenRow.price === ""
              ? null
              : Number(chosenRow.price);

          const currency = String(chosenRow.currency || "USD").trim();
          const link =
            chosenRow.variant_url
              ? String(chosenRow.variant_url).trim()
              : chosenRow.service_url
              ? String(chosenRow.service_url).trim()
              : null;

          let priceText =
            idiomaDestino === "en" ? "price available" : "precio disponible";

          if (Number.isFinite(priceNum)) {
            priceText =
              currency === "USD"
                ? `$${priceNum!.toFixed(2)}`
                : `${priceNum!.toFixed(2)} ${currency}`;
          }

          const reply =
            idiomaDestino === "en"
              ? `Perfect. The price for ${baseName} — ${variantName} is ${priceText}.${link ? `\n\nHere’s the link:\n${link}` : ""}`
              : `Perfecto. El precio de ${baseName} — ${variantName} es ${priceText}.${link ? `\n\nAquí tienes el link:\n${link}` : ""}`;

          console.log("[VARIANT_SECOND_TURN][PRICE_SELECTION]", {
            userInput,
            pickedIndex: mNum ? Number(mNum[1]) : null,
            chosenVariantId: chosenRow.id,
            chosenVariantName: variantName,
            price: chosenRow.price,
          });

          return {
            handled: true,
            reply,
            source: "price_fastpath_db",
            intent: "precio",
            ctxPatch: {
              expectingVariant: false,
              selectedServiceId: serviceId,

              last_service_id: serviceId,
              last_service_name: baseName || null,
              last_service_at: Date.now(),

              last_variant_id: String(chosenRow.id || ""),
              last_variant_name: variantName || null,
              last_variant_url: link || null,
              last_variant_at: Date.now(),

              last_price_option_label: variantName || null,
              last_price_option_at: Date.now(),

              last_bot_action: "answered_price_variant",
              last_bot_action_at: Date.now(),
            } as Partial<FastpathCtx>,
          };
        }
      }
    }

    // Traemos variantes del servicio
    const { rows: variants } = await pool.query<any>(
      `
      SELECT
        id,
        variant_name,
        description,
        variant_url,
        price,
        currency
      FROM service_variants
      WHERE service_id = $1
        AND active = true
      ORDER BY created_at ASC, id ASC
      `,
      [serviceId]
    );

    if (!variants.length) {
      // No hay variantes, limpiamos bandera y dejamos que el resto del fastpath maneje
      return {
        handled: false,
        ctxPatch: {
          expectingVariant: false,
          selectedServiceId: null,
        } as Partial<FastpathCtx>,
      };
    }

    let chosen: any = null;

    // Opción numérica: "1", "2", etc.
    const mNum = msgNorm.match(/^([1-9])$/);
    if (mNum) {
      const idx = Number(mNum[1]) - 1;
      if (idx >= 0 && idx < variants.length) {
        chosen = variants[idx];
      }
    }

    // Opción por nombre: "autopay", "por mes", etc.
    if (!chosen) {
      const msgTokens = msgNorm
        .split(/\s+/)
        .filter((t) => t.length > 1);

      chosen = variants.find((v: any) => {
        const nameNorm = normalizeText(v.variant_name || "");
        if (!nameNorm) return false;

        return msgTokens.some((t) => nameNorm.includes(t));
      });
    }

    // --------------------------------------
    // 🌎 DETECCIÓN INTELIGENTE DE VARIANTES
    // (MULTITENANT – sin hardcode por negocio)
    // --------------------------------------
    if (!chosen) {
      const matchedVariant = bestNameMatch(
        userInput,
        variants.map((v: any) => ({
          id: String(v.id),
          name: String(v.variant_name || "").trim(),
          url: v.variant_url ? String(v.variant_url).trim() : null,
        }))
      ) as any;

      if (matchedVariant?.id) {
        chosen = variants.find((v: any) => String(v.id) === String(matchedVariant.id));
      }
    }

    // Fallback genérico para alias comunes de variantes de pago
    if (!chosen) {
      const msg = msgNorm;

      const monthlyTokens = [
        "por mes",
        "mensual",
        "mensualmente",
        "mes a mes",
        "per month",
        "monthly",
      ];

      const autopayTokens = [
        "autopay",
        "auto pay",
        "pago automatico",
        "pago automático",
        "automatic payment",
        "auto debit",
        "autodebit",
        "auto-debit",
      ];

      const matchTokens = (tokens: string[], variantName: string) => {
        const vn = normalizeText(variantName);
        return tokens.some((t) => msg.includes(normalizeText(t)) || vn.includes(normalizeText(t)));
      };

      const monthlyVariant = variants.find((v: any) =>
        matchTokens(monthlyTokens, v.variant_name || "")
      );

      const autopayVariant = variants.find((v: any) =>
        matchTokens(autopayTokens, v.variant_name || "")
      );

      if (monthlyVariant && matchTokens(monthlyTokens, msg)) {
        chosen = monthlyVariant;
      }

      if (!chosen && autopayVariant && matchTokens(autopayTokens, msg)) {
        chosen = autopayVariant;
      }
    }

    if (!chosen) {
      const retryMsg =
        idiomaDestino === "en"
          ? "I’m not fully sure which option you want 🤔. Tell me the number or the name of the option."
          : "No terminé de entender cuál opción te interesa 🤔. Dime el número o el nombre de la opción.";

      return {
        handled: true,
        reply: retryMsg,
        source: "service_list_db",
        intent: intentOut || "info_servicio",
      };
    }

    // Sacamos datos del servicio base
    const {
      rows: [service],
    } = await pool.query<any>(
      `
      SELECT
        name,
        description,
        service_url
      FROM services
      WHERE id = $1
      `,
      [serviceId]
    );

    const descSource = String(
      chosen.description || service?.description || ""
    ).trim();

    const link: string | null =
      chosen.variant_url ? String(chosen.variant_url).trim()
      : service?.service_url ? String(service.service_url).trim()
      : null;

    const baseName = String(service?.name || "").trim();
    const variantName = String(chosen.variant_name || "").trim();

    const title =
      baseName && variantName
        ? `${baseName} — ${variantName}`
        : baseName || variantName || "";

    const bullets: string =
      descSource
        ? descSource
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter((l: string) => l.length > 0)
            .map((l: string) => `• ${l}`)
            .join("\n")
        : "";

    const extraContext = [
      "VARIANTE_DB_RESUELTA:",
      `- service_name: ${baseName}`,
      `- variant_name: ${variantName}`,
      `- detail_text: ${descSource || ""}`,
      `- direct_link: ${link || ""}`,
      `- source_of_truth: database`,
      "",
      "REGLAS_CRITICAS_DEL_TURNO:",
      "- Debes responder usando EXCLUSIVAMENTE los datos de VARIANTE_DB_RESUELTA.",
      "- NO puedes inventar beneficios, condiciones, precios o detalles que no estén explícitamente presentes en detail_text.",
      "- NO puedes mezclar esta variante con otras variantes, planes o servicios.",
      "- Debes conservar el contenido importante de detail_text; NO lo resumas a una sola frase genérica si detail_text contiene varios puntos relevantes.",
      "- Si detail_text contiene múltiples líneas o puntos, preséntalos de forma clara en formato chat.",
      "- Si direct_link existe, DEBES incluirlo textualmente al final de la respuesta.",
      "- Mantén la respuesta natural y adecuada al canal, pero sin perder información importante.",
      "- Cierra con una sola frase suave y breve.",
    ].join("\n");

    console.log("[FASTPATH-INCLUDES][LLM_RENDER] variant_second_turn", {
      userInput,
      serviceId,
      baseName,
      variantName,
      hasLink: !!link,
    });

    const aiVariantReply = await answerWithPromptBase({
      tenantId,
      promptBase,
      userInput,
      history: [],
      idiomaDestino,
      canal,
      maxLines: 20,
      fallbackText:
        idiomaDestino === "en"
          ? `${title ? `${title}` : ""}${
              bullets ? `\n\n${bullets}` : ""
            }${link ? `\n\nHere you can see more details:\n${link}` : ""}`
          : `${title ? `${title}` : ""}${
              bullets ? `\n\n${bullets}` : ""
            }${link ? `\n\nAquí puedes ver más detalles:\n${link}` : ""}`,
      extraContext,
    });

    let finalReply = String(aiVariantReply.text || "").trim();

    // ✅ Guardrail 1: si hay link y el LLM no lo incluyó, lo añadimos
    if (link && !finalReply.includes(link)) {
      finalReply +=
        idiomaDestino === "en"
          ? `\n\nHere you can see more details:\n${link}`
          : `\n\nAquí puedes ver más detalles:\n${link}`;
    }

    // ✅ Guardrail 2: si el LLM colapsó demasiado el detail_text, reforzamos con bullets reales
    const detailLines = String(descSource || "")
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);

    const looksTooShort =
      detailLines.length >= 3 &&
      finalReply.split(/\r?\n/).filter((l) => l.trim().length > 0).length <= 4;

    if (looksTooShort && bullets) {
      finalReply =
        idiomaDestino === "en"
          ? `${title ? `${title}` : ""}\n\n${bullets}${
              link ? `\n\nHere you can see more details:\n${link}` : ""
            }`
          : `${title ? `${title}` : ""}\n\n${bullets}${
              link ? `\n\nAquí puedes ver más detalles:\n${link}` : ""
            }`;
    }

    console.log("[VARIANT_SECOND_TURN][CHOSEN]", {
      userInput,
      serviceId,
      chosenVariantId: chosen?.id,
      chosenVariantName: chosen?.variant_name,
    });

    return {
      handled: true,
      reply: finalReply,
      source: "service_list_db",
      intent: intentOut || "info_servicio",
      ctxPatch: {
        expectingVariant: false,
        selectedServiceId: serviceId,

        last_service_id: serviceId,
        last_service_name: baseName || null,
        last_service_at: Date.now(),

        last_variant_id: String(chosen.id || ""),
        last_variant_name: variantName || null,
        last_variant_url: link || null,
        last_variant_at: Date.now(),

        last_price_option_label: variantName || null,
        last_price_option_at: Date.now(),
      } as Partial<FastpathCtx>,
    };
  }

  // ===============================
  // ✅ VARIANTES: PRIMER TURNO
  // (GENÉRICO: sirve para cualquier nombre, sin hardcodear bronce/basic/etc.)
  // ===============================
  // Texto normalizado para detectar intención de detalle
  const normMsg = normalizeForIntent(userInput);

  // Pregunta explícita de detalle: "qué incluye X", "que trae X", etc.
  const looksLikeExplicitDetail = looksLikeDetailIntent(userInput);

  // Follow-up elíptico tipo "y el gold?", "y el bronce?"
  // Lo consideramos detalle SI después de "y el/la" viene algo.
  const looksLikeEllipticDetail =
    /^y\s+(el|la)\s+.+\??$/i.test(normMsg) ||        // español
    /^and\s+(the\s+)?[^?]+(\?)?$/i.test(normMsg);    // inglés

  const looksLikeServiceDetail = looksLikeExplicitDetail || looksLikeEllipticDetail;

  const recentPriceContext =
    (
      String((convoCtx as any)?.last_bot_action || "") === "followup_set_service_for_price" ||
      Boolean((convoCtx as any)?.last_price_option_label) ||
      Boolean((convoCtx as any)?.last_variant_id) ||
      String(detectedIntent || "").trim() === "precio"
    );

  const looksLikeEllipticPriceFollowup =
    recentPriceContext &&
    (
      /^y\s+(el|la|los|las)\s+.+\??$/i.test(normMsg) ||
      /^and\s+(the\s+)?[^?]+(\?)?$/i.test(normMsg)
    ) &&
    !looksLikeExplicitDetail;

  if (
    !isCatalogOverviewTurn &&
    looksLikeServiceDetail &&
    !looksLikeEllipticPriceFollowup
  ) {
    // =========================================================
    // ✅ PRIORIDAD: si el usuario pregunta "qué incluye" y ya
    // venimos de una variante concreta reciente, responder ESA
    // variante directamente en vez de volver a listar opciones.
    // =========================================================
    {
      const now = Date.now();
      const variantTtlMs = 10 * 60 * 1000;

      const lastVariantId = String((convoCtx as any)?.last_variant_id || "").trim();
      const lastVariantAt = Number((convoCtx as any)?.last_variant_at || 0);

      const lastVariantFresh =
        !!lastVariantId &&
        Number.isFinite(lastVariantAt) &&
        lastVariantAt > 0 &&
        now - lastVariantAt <= variantTtlMs;

      const explicitTargetToken = extractCatalogTargetToken(userInput);

      // "q incluye", "que incluye", "what includes", etc.
      // pero SIN target nuevo explícito tipo "qué incluye el gold"
      const isGenericIncludesFollowup =
        looksLikeExplicitDetail && !explicitTargetToken;

      if (isGenericIncludesFollowup && lastVariantFresh) {
        const { rows: variantRows } = await pool.query<any>(
          `
          SELECT
            v.id,
            v.service_id,
            v.variant_name,
            v.description,
            v.variant_url,
            s.name AS service_name,
            s.description AS service_description,
            s.service_url
          FROM service_variants v
          JOIN services s
            ON s.id = v.service_id
          WHERE v.id = $1
            AND v.active = true
          LIMIT 1
          `,
          [lastVariantId]
        );

        const chosen = variantRows[0];

        if (chosen) {
          const baseName = String(chosen.service_name || "").trim();
          const variantName = String(chosen.variant_name || "").trim();

          const descSource = String(
            chosen.description || chosen.service_description || ""
          ).trim();

          const link =
            chosen.variant_url
              ? String(chosen.variant_url).trim()
              : chosen.service_url
              ? String(chosen.service_url).trim()
              : null;

          let displayBaseName = baseName;
          let displayVariantName = variantName;
          let displayBullets = descSource;

          if (idiomaDestino === "en") {
            try {
              if (displayBaseName) {
                displayBaseName = await traducirMensaje(displayBaseName, "en");
              }
            } catch (e) {
              console.warn("[FASTPATH-INCLUDES] error traduciendo service_name desde last_variant:", e);
            }

            try {
              if (displayVariantName) {
                displayVariantName = await traducirMensaje(displayVariantName, "en");
              }
            } catch (e) {
              console.warn("[FASTPATH-INCLUDES] error traduciendo variant_name desde last_variant:", e);
            }

            try {
              if (displayBullets) {
                const bulletList: string[] = displayBullets
                  .split(/\r?\n/)
                  .map((l: string) => l.trim())
                  .filter((l: string) => l.length > 0);

                const translated: string[] = [];
                for (const b of bulletList) {
                  translated.push(await traducirMensaje(b, "en"));
                }

                displayBullets = translated.join("\n");
              }
            } catch (e) {
              console.warn("[FASTPATH-INCLUDES] error traduciendo bullets desde last_variant:", e);
            }
          }

          const bullets =
            displayBullets
              ? displayBullets
                  .split(/\r?\n/)
                  .map((l: string) => l.trim())
                  .filter((l: string) => l.length > 0)
                  .map((l: string) => `• ${l}`)
                  .join("\n")
              : "";

          const title =
            displayBaseName && displayVariantName
              ? `${displayBaseName} — ${displayVariantName}`
              : displayBaseName || displayVariantName || "";

          let reply =
            idiomaDestino === "en"
              ? title
                ? `${title}${bullets ? ` includes:\n\n${bullets}` : ""}`
                : bullets
                ? `Includes:\n\n${bullets}`
                : ""
              : title
              ? `${title}${bullets ? ` incluye:\n\n${bullets}` : ""}`
              : bullets
              ? `Incluye:\n\n${bullets}`
              : "";

          if (link) {
            reply +=
              idiomaDestino === "en"
                ? `\n\nHere’s the link:\n${link}`
                : `\n\nAquí tienes el link:\n${link}`;
          } else {
            reply +=
              idiomaDestino === "en"
                ? `\n\nIf you need anything else, just let me know. 😊`
                : `\n\nSi necesitas algo más, avísame. 😊`;
          }

          console.log("[FASTPATH-INCLUDES] using last_variant_id directly", {
            userInput,
            lastVariantId,
            serviceId: chosen.service_id,
            baseName,
            variantName,
            link,
          });

          return {
            handled: true,
            reply,
            source: "service_list_db",
            intent: intentOut || "info_servicio",
            ctxPatch: {
              selectedServiceId: String(chosen.service_id || ""),
              expectingVariant: false,

              last_service_id: String(chosen.service_id || ""),
              last_service_name: baseName || null,
              last_service_at: Date.now(),

              last_variant_id: String(chosen.id || ""),
              last_variant_name: variantName || null,
              last_variant_url: link || null,
              last_variant_at: Date.now(),
            } as Partial<FastpathCtx>,
          };
        }
      }
    }
    
    // Detectar servicio por texto ("plan bronce", "basic bath", "deluxe groom", "facial", etc.)
    let hit: any = await resolveServiceIdFromText(pool, tenantId, userInput, {
      mode: "loose",
    });

    // 🔎 Intentar detectar target de catálogo SOLO en mensajes cortos/elípticos
    if (!hit) {
      const textForToken = normalizeText(userInput);
      const tokenWordCount = textForToken.split(/\s+/).filter(Boolean).length;

      const canUseCatalogTargetFallback =
        tokenWordCount <= 6 && !textForToken.includes("\n");

      const planToken = canUseCatalogTargetFallback
        ? extractCatalogTargetToken(userInput)
        : null;

      console.log("[CATALOG_TARGET_TOKEN] userInput =", userInput);
      console.log("[CATALOG_TARGET_TOKEN] canUseFallback =", canUseCatalogTargetFallback);
      console.log("[CATALOG_TARGET_TOKEN] extracted =", planToken);

      if (planToken) {
        const { rows } = await pool.query(
          `
          SELECT id, name
          FROM services
          WHERE tenant_id = $1
            AND active = true
            AND lower(name) LIKE $2
          ORDER BY created_at ASC
          LIMIT 5
          `,
          [tenantId, `%${planToken}%`]
        );

        console.log(
          "[CATALOG_TARGET_TOKEN] candidate rows =",
          rows.map((r: any) => r.name)
        );

        if (rows.length === 1) {
          hit = {
            serviceId: rows[0].id,
            serviceName: rows[0].name,
          };
        }

        if (rows.length > 1) {
          console.log("[FASTPATH_BRANCH] plan_group_disambiguation", {
            userInput,
            candidates: rows.map((r: any) => r.name),
          });

          const reply =
            idiomaDestino === "en"
              ? `Just to confirm 😊 are you asking about:\n\n${rows
                  .map((r: any, i: number) => `• ${i + 1}) ${r.name}`)
                  .join("\n")}\n\nReply with the number or the name and I'll tell you what it includes.`
              : `Solo para confirmar 😊 ¿te refieres a:\n\n${rows
                  .map((r: any, i: number) => `• ${i + 1}) ${r.name}`)
                  .join("\n")}\n\nRespóndeme con el número o el nombre y te explico qué incluye.`;

          return {
            handled: true,
            reply,
            source: "service_list_db",
            intent: "info_servicio",
            ctxPatch: {
              last_plan_list: rows.map((r: any) => ({
                id: String(r.id),
                name: String(r.name || "").trim(),
                url: null,
              })),
              last_plan_list_at: Date.now(),
              last_list_kind: "plan",
              last_list_kind_at: Date.now(),

              pending_price_lookup: true,
              pending_price_at: Date.now(),
              pending_price_target_text: userInput,
              pending_price_raw_user_text: userInput,

              last_bot_action: "asked_plan_group_disambiguation",
              last_bot_action_at: Date.now(),
            } as Partial<FastpathCtx>,
          };
        }
      }
    }

    // 🛠 FIX: Si el texto coincide con una variante exacta,
    // NO tratamos esa variante como un servicio independiente.
    if (hit && hit.isVariant) {
      const serviceOfVariant = hit.service_id;

      // Reescribimos hit para que el motor trate esto como SERVICIO
      hit = {
        id: serviceOfVariant,
        name: hit.parent_service_name,
      };
    }

    const explicitGroupToken = extractCatalogTargetToken(userInput);
    const hasExplicitNewTarget = !!explicitGroupToken;

    // 🔥 PATCH NUEVO: si es detalle pero no se encontró servicio por texto,
    // usar SERVICE en contexto (último plan mostrado o seleccionado)
    if (!hit && !hasExplicitNewTarget) {
      if (convoCtx?.last_plan_list?.length === 1) {
        hit = {
          id: convoCtx.last_plan_list[0].id,
          name: convoCtx.last_plan_list[0].name,
        };
      } else if (convoCtx?.selectedServiceId) {
        hit = {
          id: convoCtx.selectedServiceId,
          name: convoCtx.last_service_name || "",
        };
      } else if (convoCtx?.last_service_id) {
        hit = {
          id: convoCtx.last_service_id,
          name: convoCtx.last_service_name || "",
        };
      }
    }

    // Si después de intentar contexto TAMPOCO hay servicio, dejar catálogo/LLM
    if (!hit) {
      // No encontramos servicio claro → motor catálogo
    } else {
      const serviceId = hit.serviceId || hit.id;

      // Traer variantes de ese servicio
      const { rows: variants } = await pool.query<any>(
        `
        SELECT
          id,
          variant_name,
          description,
          variant_url,
          price,
          currency
        FROM service_variants
        WHERE service_id = $1
          AND active = true
        ORDER BY created_at ASC, id ASC
        `,
        [serviceId]
      );

      // Traer info básica del servicio
      const {
        rows: [service],
      } = await pool.query<any>(
        `
        SELECT
          name,
          description,
          service_url
        FROM services
        WHERE id = $1
        `,
        [serviceId]
      );

      const serviceName = String(service?.name || hit.serviceName || hit.name || "").trim();

      // ⭐ Caso A: tiene variantes → listamos opciones y preguntamos cuál le interesa
      if (variants.length > 0) {
        console.log("[FASTPATH_BRANCH] service_variant_list", {
          userInput,
          serviceId,
          serviceName,
          variants: variants.map((v:any)=>v.variant_name)
        });

        console.log("[FASTPATH-INCLUDES] variantes primer turno", {
          userInput,
          serviceId,
          serviceName,
          variants: variants.map((v: any) => v.variant_name),
        });

        // Nombre que vamos a mostrar del servicio (traducido si aplica)
        let displayServiceName = serviceName;

        // Si el cliente está en inglés, intentamos traducir el nombre del servicio
        if (idiomaDestino === "en" && serviceName) {
          try {
            // 👇 Ajusta la firma si tu helper `traducirMensaje` recibe otros parámetros
            displayServiceName = await traducirMensaje(serviceName, "en");
          } catch (e) {
            console.warn("[FASTPATH-INCLUDES] error traduciendo nombre de servicio:", e);
          }
        }

        // Construimos las líneas de variantes (traduciendo el nombre si el cliente está en EN)
        const lines = await Promise.all(
          variants.map(async (v: any, idx: number) => {
            const rawPrice = v.price;

            // Postgres suele devolver NUMERIC como string → lo convertimos
            const numPrice =
              rawPrice === null || rawPrice === undefined || rawPrice === ""
                ? NaN
                : Number(rawPrice);

            const currency = (v.currency as string | null) || "USD";
            const hasPrice = Number.isFinite(numPrice);
            const priceText = hasPrice ? `${numPrice} ${currency}` : "";

            let displayVariantName = String(v.variant_name || "").trim();

            if (idiomaDestino === "en" && displayVariantName) {
              try {
                // 👇 Igual: adapta la firma si tu helper es distinto
                displayVariantName = await traducirMensaje(displayVariantName, "en");
              } catch (e) {
                console.warn(
                  "[FASTPATH-INCLUDES] error traduciendo nombre de variante:",
                  e
                );
              }
            }

            return priceText
              ? `• ${idx + 1}) ${displayVariantName}: ${priceText}`
              : `• ${idx + 1}) ${displayVariantName}`;
          })
        );

        const headerEs = `El ${serviceName} tiene estas opciones:`;
        const headerEn = `The ${displayServiceName} has these options:`;

        const askEs =
          "¿Cuál opción te interesa? Puedes responder con el número o el nombre.";
        const askEn =
          "Which option are you interested in? You can answer with the number or the name.";

        const reply =
          idiomaDestino === "en"
            ? `${headerEn}\n\n${lines.join("\n")}\n\n${askEn}`
            : `${headerEs}\n\n${lines.join("\n")}\n\n${askEs}`;

        return {
          handled: true,
          reply,
          source: "service_list_db",
          intent: intentOut || "info_servicio",
          ctxPatch: {
            selectedServiceId: serviceId,
            expectingVariant: true,

            last_service_id: serviceId,
            last_service_name: serviceName || null,
            last_service_at: Date.now(),

            last_variant_id: null,
            last_variant_name: null,
            last_variant_url: null,
            last_variant_at: null,

            last_variant_options: variants.map((v: any, idx: number) => ({
              index: idx + 1,
              id: String(v.id || ""),
              name: String(v.variant_name || "").trim(),
              url: v.variant_url ? String(v.variant_url).trim() : null,
            })),
            last_variant_options_at: Date.now(),
          } as Partial<FastpathCtx>,
        };
      }

      // ⭐ Caso B: NO tiene variantes → respondemos directo con descripción + link
      console.log("[FASTPATH_BRANCH] service_detail", {
        userInput,
        serviceId,
        serviceName,
        serviceUrl: service?.service_url || null
      });

      const descSource = (service?.description || "").trim();
      const link: string | null = service?.service_url || null;

      let displayServiceName = serviceName;      // puede venir vacío — NO inventamos nada
      let displayBullets = descSource;

      // --------------------------------------
      // 🌎 TRADUCCIÓN (solo si el cliente habla EN)
      // --------------------------------------
      if (idiomaDestino === "en") {
        try {
          if (displayServiceName) {
            displayServiceName = await traducirMensaje(displayServiceName, "en");
          }
        } catch (e) {
          console.warn("[FASTPATH] error traduciendo nombre (sin variantes):", e);
        }

        try {
          if (displayBullets) {
            const bulletList: string[] = displayBullets
              .split(/\r?\n/)
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0);

            const translated: string[] = [];
            for (const b of bulletList) {
              translated.push(await traducirMensaje(b, "en"));
            }

            displayBullets = translated.join("\n");
          }
        } catch (e) {
          console.warn("[FASTPATH] error traduciendo bullets (sin variantes):", e);
        }
      }

      // --------------------------------------
      // Generar bullets visuales
      // --------------------------------------
      const bullets =
        displayBullets
          ? displayBullets
              .split(/\r?\n/)
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0)
              .map((l: string) => `• ${l}`)
              .join("\n")
          : "";

      // --------------------------------------
      // Respuesta final SIN hardcode de tipo
      // --------------------------------------

      // ❗ No mostramos "Este plan" ni "This plan"
      // Si hay nombre → mostramos nombre.
      // Si NO hay nombre → solo mostramos bullets (sin inventar nada).
      let reply: string;

      if (idiomaDestino === "en") {
        reply = displayServiceName
          ? `${displayServiceName}${bullets ? ` includes:\n\n${bullets}` : ""}`
          : bullets
          ? `Includes:\n\n${bullets}`
          : "";
      } else {
        reply = displayServiceName
          ? `${displayServiceName}${bullets ? ` incluye:\n\n${bullets}` : ""}`
          : bullets
          ? `Incluye:\n\n${bullets}`
          : "";
      }

      if (link) {
        reply +=
          idiomaDestino === "en"
            ? `\n\nHere you can see more details:\n${link}`
            : `\n\nAquí puedes ver más detalles:\n${link}`;
      }

      console.log("[FASTPATH_REPLY_SENT]", {
        userInput,
        serviceId,
        serviceName,
        linkIncluded: link || null
      });

      return {
        handled: true,
        reply,
        source: "service_list_db",
        intent: intentOut || "info_servicio",
        ctxPatch: {
          selectedServiceId: serviceId,
          expectingVariant: false,
          last_service_id: serviceId,
          last_service_name: serviceName,
          last_service_at: Date.now(),
        } as Partial<FastpathCtx>,
      };
    }
  }

  // ===============================
  // 🧠 MOTOR ÚNICO DE CATÁLOGO
  // ===============================
    {
    const catalogRoutingSignal = buildCatalogRoutingSignal({
      intentOut,
      catalogReferenceClassification,
      convoCtx,
    });

    console.log("[CATALOG][ROUTING_SIGNAL]", {
      userInput,
      intentOut,
      signal: {
        shouldRouteCatalog: catalogRoutingSignal.shouldRouteCatalog,
        routeIntent: catalogRoutingSignal.routeIntent,
        referenceKind: catalogRoutingSignal.referenceKind,
        source: catalogRoutingSignal.source,
        allowsDbCatalogPath: catalogRoutingSignal.allowsDbCatalogPath,
        hasFreshCatalogContext: catalogRoutingSignal.hasFreshCatalogContext,
        previousCatalogPlans: catalogRoutingSignal.previousCatalogPlans,
        targetServiceId: catalogRoutingSignal.targetServiceId,
        targetServiceName: catalogRoutingSignal.targetServiceName,
      },
    });

    const isCombinationIntent =
      q.includes("combinar") ||
      q.includes("mezclar") ||
      q.includes("usar ambas") ||
      q.includes("usar las dos") ||
      q.includes("combine classes") ||
      q.includes("use both") ||
      q.includes("combinada") ||
      q.includes("combinado") ||
      q.includes("ambas clases") ||
      q.includes("ambos tipos") ||
      q.includes("all inclusive") ||
      q.includes("todo incluido");

    const qNorm = normalizeText(userInput);

    const asksIncludesOnly =
      looksLikeDetailIntent(userInput) ||
      /\b(q incluye|que incluye|qué incluye|incluye|what includes|what is included)\b/i.test(q);

    const isAskingOtherCatalogOptions =
      qNorm.includes("otro plan") ||
      qNorm.includes("otros planes") ||
      qNorm.includes("otras opciones") ||
      qNorm.includes("que otras opciones tienes") ||
      qNorm.includes("q otras opciones tienes") ||
      qNorm.includes("que mas tienes") ||
      qNorm.includes("q mas tienes") ||
      qNorm.includes("que mas opciones tienes") ||
      qNorm.includes("q mas opciones tienes") ||
      qNorm.includes("que otros planes tienes") ||
      qNorm.includes("q otros planes tienes") ||
      qNorm.includes("que otros productos") ||
      qNorm.includes("q otros productos") ||
      qNorm.includes("otros productos") ||
      qNorm.includes("que mas productos") ||
      qNorm.includes("q mas productos") ||
      qNorm.includes("que otros servicios") ||
      qNorm.includes("q otros servicios") ||
      qNorm.includes("otros servicios") ||
      qNorm.includes("que mas servicios") ||
      qNorm.includes("q mas servicios") ||
      qNorm === "otras opciones" ||
      qNorm === "otros planes" ||
      qNorm === "otros productos" ||
      qNorm === "otros servicios" ||
      qNorm === "que mas" ||
      qNorm === "q mas" ||
      qNorm.includes("more plans") ||
      qNorm.includes("other plans") ||
      qNorm.includes("other products") ||
      qNorm.includes("more products") ||
      qNorm.includes("other services") ||
      qNorm.includes("more services") ||
      qNorm.includes("what other options");

    const isCatalogQuestionBasic = false;

    const hasRecentCatalogContext = catalogRoutingSignal.hasFreshCatalogContext;

    const intentAllowsCatalogRouting = catalogRoutingSignal.allowsDbCatalogPath;

    const isCatalogQuestion =
      catalogRoutingSignal.shouldRouteCatalog || isPriceQuestion(userInput, convoCtx);

    // 🔒 Nunca permitir que el LLM responda precios
    if (isPriceQuestion(userInput, convoCtx)) {
      console.log("🚫 BLOCK LLM PRICING — forcing DB path");
      // dejamos que el flujo continúe para que el branch de DB responda
    }

    if (!isCatalogQuestion) {
      // deja continuar con el resto del fastpath
    } else {
      const isPriceLike =
        isPriceQuestion(userInput, convoCtx) ||
        q.includes("plan") ||
        q.includes("planes") ||
        q.includes("membresia") ||
        q.includes("membresía") ||
        q.includes("membership") ||
        q.includes("paquete") ||
        q.includes("package") ||
        q.includes("bundle");

      type QuestionType = "combination_and_price" | "price_or_plan" | "other_plans";

      let questionType: QuestionType;

      // PRIORIDAD:
      // 1) Pregunta de combinación, aunque no diga "precio"
      if (isCombinationIntent) {
        questionType = "combination_and_price";
      } else if (isAskingOtherCatalogOptions) {
        questionType = "other_plans";
      } else if (isCatalogOverviewTurn) {
        questionType = "price_or_plan";
      } else if (isCatalogFamilyTurn) {
        questionType = "price_or_plan";
      } else {
        questionType = "price_or_plan";
      }

      if (isCatalogOverviewTurn && intentAllowsCatalogRouting) {
        console.log("[CATALOG_OVERVIEW][RUN_FASTPATH]", {
          userInput,
          questionType,
          detectedIntent,
          catalogReferenceKind: catalogReferenceClassification?.kind ?? "none",
        });
      }

      if (isCatalogFamilyTurn && intentAllowsCatalogRouting) {
        console.log("[CATALOG_FAMILY][RUN_FASTPATH]", {
          userInput,
          questionType,
          detectedIntent,
          catalogReferenceKind: catalogReferenceClassification?.kind ?? "none",
        });
      }

      const asksSchedules =
        /\b(horario|horarios|hora|horas|hours?|schedule|schedules)\b/i.test(q);
      const catalogText = await buildCatalogContext(pool, tenantId);

      const hasMultiAccessPlan =
        /todas las clases|todas nuestras clases|todas las sesiones|all classes|all services|any class|unlimited/i.test(
          catalogText
        );

      // ✅ construir PREVIOUS_PLANS_MENTIONED desde el contexto
      const nowForMeta = Date.now();
      let previousPlansStr = "none";
      const prevNames = Array.isArray(convoCtx?.last_catalog_plans)
        ? convoCtx.last_catalog_plans!
        : [];
      const prevAtRaw = (convoCtx as any)?.last_catalog_at;
      const prevAt = Number(prevAtRaw);
      const prevFresh =
        prevNames.length > 0 &&
        Number.isFinite(prevAt) &&
        prevAt > 0 &&
        nowForMeta - prevAt <= 30 * 60 * 1000; // 30 minutos

      if (prevFresh) {
        previousPlansStr = prevNames.join(" | ");
      }

      const metaBlock =
        `QUESTION_TYPE: ${questionType}\n` +
        `HAS_MULTI_ACCESS_PLAN: ${hasMultiAccessPlan ? "yes" : "no"}\n` +
        `PREVIOUS_PLANS_MENTIONED: ${previousPlansStr}`;

      // ⚖️ Solo adjuntar horarios / info general cuando:
      // - el usuario menciona horarios/horas/schedule, o
      // - la intención es info_general / info_horarios_generales
      const shouldAttachInfoGeneral =
        !!infoClave &&
        (asksSchedules ||
          intentOut === "info_general" ||
          intentOut === "info_horarios_generales");

      const infoGeneralBlock = shouldAttachInfoGeneral
        ? idiomaDestino === "en"
          ? `\n\nBUSINESS_GENERAL_INFO (hours, address, etc.):\n${infoClave}`
          : `\n\nINFO_GENERAL_DEL_NEGOCIO (horarios, dirección, etc.):\n${infoClave}`
        : "";

      // ✅ Precio/planes genérico: responder desde DB (no LLM).
      if (!asksSchedules && !asksIncludesOnly && questionType === "price_or_plan") {
        const { rows } = await pool.query<{
          service_id: string;
          service_name: string;
          min_price: number | string | null;
          max_price: number | string | null;
          parent_service_id: string | null;
          category: string | null;
          catalog_role: string | null;
        }>(`
          WITH variant_prices AS (
            SELECT
              s.id AS service_id,
              s.name AS service_name,
              s.parent_service_id,
              s.category,
              s.catalog_role,
              MIN(v.price)::numeric AS min_price,
              MAX(v.price)::numeric AS max_price
            FROM services s
            JOIN service_variants v
              ON v.service_id = s.id
            AND v.active = true
            WHERE s.tenant_id = $1
              AND s.active = true
              AND v.price IS NOT NULL
            GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
          ),
          base_prices AS (
            SELECT
              s.id AS service_id,
              s.name AS service_name,
              s.parent_service_id,
              s.category,
              s.catalog_role,
              MIN(s.price_base)::numeric AS min_price,
              MAX(s.price_base)::numeric AS max_price
            FROM services s
            WHERE s.tenant_id = $1
              AND s.active = true
              AND s.price_base IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                FROM service_variants v
                WHERE v.service_id = s.id
                  AND v.active = true
                  AND v.price IS NOT NULL
              )
            GROUP BY s.id, s.name, s.parent_service_id, s.category, s.catalog_role
          )
          SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role
          FROM (
            SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM variant_prices
            UNION ALL
            SELECT service_id, service_name, min_price, max_price, parent_service_id, category, catalog_role FROM base_prices
          ) x;
        `, [tenantId]);

        // =========================================================
        // ✅ SINGLE PRICE TARGET RESOLUTION
        // Intenta resolver una referencia concreta antes de listar catálogo.
        // Si es follow-up elíptico de precio, reutiliza el último servicio.
        // =========================================================
        const shouldSkipSinglePriceTargetResolution =
          catalogReferenceClassification?.kind === "catalog_overview";

        const ellipticPriceFollowup = isEllipticPriceFollowup(userInput, convoCtx);

        const ctxServiceId =
          String(convoCtx?.last_service_id || "").trim() ||
          String(convoCtx?.selectedServiceId || "").trim();

        const ctxServiceName =
          String(convoCtx?.last_service_name || "").trim();

        const matches =
          shouldSkipSinglePriceTargetResolution || ellipticPriceFollowup
            ? []
            : await resolveServiceMatchesFromText(pool, tenantId, userInput, {
                minScore: 0.25,
                maxResults: 5,
                relativeWindow: 0.25,
              });

        const top = matches[0] || null;
        const second = matches[1] || null;

        const topScore = Number(top?.score || 0);
        const secondScore = Number(second?.score || 0);

        const hasStrongAmbiguity =
          matches.length >= 2 &&
          top &&
          second &&
          topScore >= 0.45 &&
          secondScore >= 0.45 &&
          Math.abs(topScore - secondScore) < 0.15;

        const singleHit =
          hasStrongAmbiguity
            ? null
            : shouldSkipSinglePriceTargetResolution
            ? null
            : ellipticPriceFollowup && ctxServiceId
            ? {
                id: ctxServiceId,
                name: ctxServiceName,
              }
            : top
            ? {
                id: String(top.id || ""),
                name: String(top.name || "").trim(),
              }
            : null;

        if (shouldSkipSinglePriceTargetResolution) {
          console.log("[PRICE][single] skipped_by_catalog_reference_classification", {
            userInput,
            catalogReferenceKind: catalogReferenceClassification?.kind ?? "none",
          });
        }

        console.log("[PRICE][single] resolve output", {
          userInput,
          ellipticPriceFollowup,
          hasStrongAmbiguity,
          matches: matches.map((m: any) => ({
            id: String(m.id || ""),
            name: String(m.name || "").trim(),
            score: Number(m.score || 0),
          })),
          singleHit,
          ctxLastService: convoCtx?.last_service_id
            ? {
                id: convoCtx.last_service_id,
                name: convoCtx.last_service_name || null,
              }
            : null,
        });

        if (hasStrongAmbiguity) {
          const options = matches.slice(0, 4).map((m: any, idx: number) => ({
            index: idx + 1,
            id: String(m.id || ""),
            name: String(m.name || "").trim(),
          }));

          const header =
            idiomaDestino === "en"
              ? `To give you the correct information, I first need to know which option you mean 😊`
              : `Para darte la informacion correcta, primero necesito saber a cuál opción te refieres 😊`;

          const ask =
            idiomaDestino === "en"
              ? `Which one are you interested in? You can reply with the number or the name.`
              : `¿Cuál te interesa? Puedes responder con el número o el nombre.`;

          const lines = options.map((o) => `• ${o.index}) ${o.name}`);

          return {
            handled: true,
            reply: `${header}\n\n${lines.join("\n")}\n\n${ask}`,
            source: "price_disambiguation_db",
            intent: "precio",
            ctxPatch: {
              last_plan_list: options.map((o) => ({
                id: o.id,
                name: o.name,
                url: null,
              })),
              last_plan_list_at: Date.now(),
              last_list_kind: "plan",
              last_list_kind_at: Date.now(),

              last_service_id: null,
              last_service_name: null,
              selectedServiceId: null,

              last_selected_kind: null,
              last_selected_id: null,
              last_selected_name: null,
              last_selected_at: null,

              last_bot_action: "asked_entity_disambiguation",
              last_bot_action_at: Date.now(),
            } as Partial<FastpathCtx>,
          };
        }

        if (singleHit?.id) {
          const targetServiceId = String(singleHit.id || "").trim();
          const targetServiceName = String(singleHit.name || "").trim();

          const { rows: variants } = await pool.query<any>(
            `
            SELECT
              id,
              variant_name,
              description,
              variant_url,
              price,
              currency
            FROM service_variants
            WHERE service_id = $1
              AND active = true
            ORDER BY created_at ASC, id ASC
            `,
            [targetServiceId]
          );

          console.log("[PRICE][single] variants fetched", {
            targetServiceId,
            targetServiceName,
            variants: variants.map((v: any) => ({
              id: v.id,
              variant_name: v.variant_name,
              price: v.price,
              currency: v.currency,
            })),
          });

          const pricedVariants = variants.filter((v: any) => {
            const n = Number(v.price);
            return Number.isFinite(n) && n > 0;
          });

          let chosenVariant: any = null;

          if (pricedVariants.length > 0) {
            const msgNorm = normalizeText(userInput);

            const storedVariantOptions = Array.isArray((convoCtx as any)?.last_variant_options)
              ? (convoCtx as any).last_variant_options
              : [];

            const isAwaitingPriceVariantSelection =
              String((convoCtx as any)?.last_bot_action || "") === "asked_price_variant" &&
              Boolean((convoCtx as any)?.expectingVariant) &&
              storedVariantOptions.length > 0;

            // 1) Si venimos de una lista numerada de precio, usar SIEMPRE el índice mostrado
            const numericSelection = msgNorm.match(/^([1-9])$/)?.[1] || null;

            if (isAwaitingPriceVariantSelection && numericSelection) {
              const pickedIndex = Number(numericSelection);

              const pickedFromContext =
                storedVariantOptions.find((opt: any) => Number(opt.index) === pickedIndex) || null;

              if (pickedFromContext?.id) {
                chosenVariant =
                  pricedVariants.find(
                    (v: any) => String(v.id) === String(pickedFromContext.id)
                  ) || null;
              }

              console.log("[PRICE][single][INDEX_SELECTION_FROM_CONTEXT]", {
                userInput,
                pickedIndex,
                pickedFromContext,
                chosenVariant: chosenVariant
                  ? {
                      id: chosenVariant.id,
                      variant_name: chosenVariant.variant_name,
                      price: chosenVariant.price,
                    }
                  : null,
              });
            }

            // 2) Si no hubo selección por índice contextual, intentar por nombre exacto / fuzzy
            if (!chosenVariant) {
              const matchedVariant = bestNameMatch(
                userInput,
                pricedVariants.map((v: any) => ({
                  id: String(v.id),
                  name: String(v.variant_name || "").trim(),
                  url: v.variant_url ? String(v.variant_url).trim() : null,
                }))
              ) as any;

              if (matchedVariant?.id) {
                chosenVariant = pricedVariants.find(
                  (v: any) => String(v.id) === String(matchedVariant.id)
                );
              }
            }

            // 3) Fallback viejo SOLO si no estamos en selección contextual numerada
            if (!chosenVariant && !isAwaitingPriceVariantSelection) {
              const numberInMsg = msgNorm.match(/\b(\d{1,3})\b/)?.[1] || null;

              if (numberInMsg) {
                chosenVariant =
                  pricedVariants.find((v: any) => {
                    const vName = normalizeText(String(v.variant_name || ""));
                    return new RegExp(`\\b${numberInMsg}\\b`).test(vName);
                  }) || null;
              }
            }
          }

            console.log("[PRICE][single] final reply inputs", {
              targetServiceId,
              targetServiceName,
              variantsCount: variants.length,
              pricedVariantsCount: pricedVariants.length,
              chosenVariant: chosenVariant
                ? {
                    id: chosenVariant.id,
                    variant_name: chosenVariant.variant_name,
                    price: chosenVariant.price,
                    currency: chosenVariant.currency,
                  }
                : null,
            });
            
          // ✅ Si resolvió variante concreta, responder con answerWithPromptBase
          // usando precio + includes reales desde DB, sin link automático
          // y con guardrail para no alterar la fuente de verdad.
          if (chosenVariant) {
            console.log("[PRICE][chosenVariant]", {
              userInput,
              targetServiceId,
              targetServiceName,
              chosenVariant: {
                id: chosenVariant?.id,
                variant_name: chosenVariant?.variant_name,
                price: chosenVariant?.price,
                variant_url: chosenVariant?.variant_url,
              },
              allVariants: pricedVariants.map((v: any) => ({
                id: v.id,
                variant_name: v.variant_name,
                price: v.price,
              })),
            });

            const priceNum =
              chosenVariant.price === null ||
              chosenVariant.price === undefined ||
              chosenVariant.price === ""
                ? null
                : Number(chosenVariant.price);

            const baseName = targetServiceName || "";
            const variantName = String(chosenVariant.variant_name || "").trim();
            const resolvedCurrency = String(chosenVariant.currency || "USD");

            const {
              rows: [serviceBase],
            } = await pool.query<any>(
              `
              SELECT description
              FROM services
              WHERE id = $1
              LIMIT 1
              `,
              [targetServiceId]
            );

            const serviceDescription = String(
              chosenVariant.description || serviceBase?.description || ""
            ).trim();

            let priceText =
              idiomaDestino === "en" ? "price available" : "precio disponible";

            if (Number.isFinite(priceNum)) {
              priceText =
                resolvedCurrency === "USD"
                  ? `$${priceNum!.toFixed(2)}`
                  : `${priceNum!.toFixed(2)} ${resolvedCurrency}`;
            }

            const detailLines = serviceDescription
              ? serviceDescription
                  .split(/\r?\n/)
                  .map((l: string) => l.trim())
                  .filter((l: string) => l.length > 0)
              : [];

            const bulletsText = detailLines.length
              ? detailLines.map((l: string) => `• ${l}`).join("\n")
              : "";

            const canonicalBody =
              idiomaDestino === "en"
                ? `${baseName} — ${variantName}\nPrice: ${priceText}${
                    bulletsText ? `\n\nIncludes:\n${bulletsText}` : ""
                  }`
                : `${baseName} — ${variantName}\nPrecio: ${priceText}${
                    bulletsText ? `\n\nIncluye:\n${bulletsText}` : ""
                  }`;

            const wrapperFallback =
              idiomaDestino === "en"
                ? {
                    intro: "Perfect 😊",
                    outro: "If you need anything else, just let me know 😊",
                  }
                : {
                    intro: "Perfecto 😊",
                    outro: "Si necesitas algo más, avísame 😊",
                  };

            const wrapperInstruction =
              idiomaDestino === "en"
                ? [
                    "You are rendering a WhatsApp sales reply.",
                    "IMPORTANT: You are NOT allowed to rewrite the canonical body.",
                    "You may ONLY produce:",
                    "- a very short natural intro",
                    "- a very short natural outro",
                    "Do NOT change product/service facts.",
                    "Do NOT restate or paraphrase the body.",
                    "Do NOT add prices, conditions, benefits, links, durations, or names not already resolved.",
                    'Return valid JSON with exactly this shape: {"intro":"...","outro":"..."}',
                  ].join("\n")
                : [
                    "Estás renderizando una respuesta comercial para WhatsApp.",
                    "IMPORTANTE: NO puedes reescribir el cuerpo canónico.",
                    "Solo puedes producir:",
                    "- un intro muy breve y natural",
                    "- un cierre muy breve y natural",
                    "NO cambies hechos del servicio o producto.",
                    "NO repitas ni parafrasees el cuerpo.",
                    "NO agregues precios, condiciones, beneficios, links, duraciones ni nombres no resueltos.",
                    'Devuelve JSON válido con esta forma exacta: {"intro":"...","outro":"..."}',
                  ].join("\n");

            const wrapperContext = [
              "CANONICAL_BODY_START",
              canonicalBody,
              "CANONICAL_BODY_END",
              "",
              "REGLAS_CRITICAS:",
              "- El cuerpo canónico se insertará después por el sistema.",
              "- No debes reescribirlo.",
              "- intro: máximo 1 línea.",
              "- outro: máximo 1 línea.",
              "- El intro debe sonar natural, cálido y breve.",
              "- El cierre debe sonar natural y comercial, sin sonar robótico.",
              "- No hagas preguntas obligatorias de sí/no.",
              "- No menciones links en intro ni outro.",
              "- No uses saludo tipo 'Hola' si la conversación ya está en curso.",
              "- No digas 'te recomiendo' si el usuario ya eligió una opción concreta.",
              "- El intro debe funcionar como confirmación breve de la selección, no como nueva recomendación.",
            ].join("\n");

            console.log("[PRICE][single][LLM_RENDER_WRAPPER_ONLY]", {
              targetServiceId,
              targetServiceName,
              variantName,
              priceNum,
              resolvedCurrency,
              hasDetailText: !!serviceDescription,
            });

            const wrapperReply = await answerWithPromptBase({
              tenantId,
              promptBase: `${promptBase}\n\n${wrapperInstruction}`,
              userInput:
                idiomaDestino === "en"
                  ? "Render only a short confirmation intro and a soft commercial closing."
                  : "Renderiza solo un intro breve de confirmación y un cierre comercial suave.",
              history: [],
              idiomaDestino,
              canal,
              maxLines: 4,
              fallbackText: JSON.stringify(wrapperFallback),
              extraContext: wrapperContext,
            });

            let intro = wrapperFallback.intro;
            let outro = wrapperFallback.outro;

            try {
              const parsed = JSON.parse(String(wrapperReply.text || "").trim());

              if (parsed && typeof parsed === "object") {
                const parsedIntro = String(parsed.intro || "").trim();
                const parsedOutro = String(parsed.outro || "").trim();

                if (parsedIntro) intro = parsedIntro;
                if (parsedOutro) outro = parsedOutro;
              }
            } catch {
              // fallback silencioso
            }

            const finalReply = [intro, canonicalBody, outro]
              .filter((x) => String(x || "").trim().length > 0)
              .join("\n\n");

            console.log("[PRICE][single][WRAPPER_RESULT]", {
              intro,
              outro,
              canonicalBodyPreview: canonicalBody.slice(0, 220),
              finalReplyPreview: finalReply.slice(0, 260),
            });

            return {
              handled: true,
              reply: finalReply,
              source: "price_fastpath_db_llm_render",
              intent: "precio",
              ctxPatch: {
                last_service_id: targetServiceId,
                last_service_name: baseName || null,
                last_service_at: Date.now(),

                last_variant_id: String(chosenVariant.id || ""),
                last_variant_name: variantName || null,
                last_variant_url: null,
                last_variant_at: Date.now(),

                last_price_option_label: variantName || null,
                last_price_option_at: Date.now(),
              } as Partial<FastpathCtx>,
            };
          }

          // ✅ Si hay varias variantes con precio y el usuario NO eligió una,
          // listar variantes para que seleccione en vez de resumir por rango.
          if (pricedVariants.length > 1 && !chosenVariant) {
            console.log("[PRICE][single] multiple priced variants -> list for selection", {
              targetServiceId,
              targetServiceName,
              pricedVariants: pricedVariants.map((v: any, idx: number) => ({
                index: idx + 1,
                id: v.id,
                variant_name: v.variant_name,
                price: v.price,
                currency: v.currency,
                variant_url: v.variant_url,
              })),
            });

            const lines = pricedVariants.map((v: any, idx: number) => {
              const rawPrice =
                v.price === null || v.price === undefined || v.price === ""
                  ? NaN
                  : Number(v.price);

              const currency = String(v.currency || "USD").trim();
              const variantName = String(v.variant_name || "").trim();

              let priceText =
                idiomaDestino === "en" ? "price available" : "precio disponible";

              if (Number.isFinite(rawPrice)) {
                if (currency === "USD") {
                  priceText = `$${rawPrice.toFixed(2)}`;
                } else {
                  priceText = `${rawPrice.toFixed(2)} ${currency}`;
                }
              }

              return `• ${idx + 1}) ${variantName}: ${priceText}`;
            });

            const header =
              idiomaDestino === "en"
                ? `${targetServiceName} has these options:`
                : `${targetServiceName} tiene estas opciones:`;

            const ask =
              idiomaDestino === "en"
                ? "Which option are you interested in? You can reply with the number or the name."
                : "¿Cuál opción te interesa? Puedes responder con el número o el nombre.";

            return {
              handled: true,
              reply: `${header}\n\n${lines.join("\n")}\n\n${ask}`,
              source: "price_disambiguation_db",
              intent: "precio",
              ctxPatch: {
                selectedServiceId: targetServiceId,
                expectingVariant: true,

                last_service_id: targetServiceId,
                last_service_name: targetServiceName || null,
                last_service_at: Date.now(),

                last_variant_id: null,
                last_variant_name: null,
                last_variant_url: null,
                last_variant_at: null,

                last_variant_options: pricedVariants.map((v: any, idx: number) => ({
                  index: idx + 1,
                  id: String(v.id || ""),
                  name: String(v.variant_name || "").trim(),
                  url: v.variant_url ? String(v.variant_url).trim() : null,
                  price:
                    v.price === null || v.price === undefined || v.price === ""
                      ? null
                      : Number(v.price),
                  currency: String(v.currency || "USD").trim(),
                })),
                last_variant_options_at: Date.now(),

                last_price_option_label: null,
                last_price_option_at: null,

                last_bot_action: "asked_price_variant",
                last_bot_action_at: Date.now(),
              } as Partial<FastpathCtx>,
            };
          }

          // ✅ Si resolvió servicio, pero no variante exacta, responder natural usando DB + answerWithPromptBase
          const matchedRow = rows.find(
            (r) => String(r.service_id || "") === targetServiceId
          );

          const hasServicePriceRow = !!matchedRow;

          if (pricedVariants.length === 0 && !hasServicePriceRow) {
            console.log("[PRICE][single][LLM_RENDER] no_price_policy_fallback", {
              targetServiceId,
              targetServiceName,
            });

            const extraContext = [
              "PRECIO_DB_RESUELTO:",
              `- service_name: ${targetServiceName}`,
              `- pricing_mode: no_explicit_price`,
              `- source_of_truth: database`,
              "",
              "REGLAS_CRITICAS_DEL_TURNO:",
              "- El servicio fue resuelto correctamente desde DB.",
              "- Este servicio NO tiene precio explícito en variantes ni en price_base.",
              "- NO puedes inventar montos, rangos, estimados, visitas, evaluaciones ni cotizaciones si no están explícitamente configurados.",
              "- NO puedes cambiar a otros servicios del catálogo.",
              "- Debes responder SOLO sobre este servicio.",
              "- Si no hay precio disponible, dilo de forma natural y breve sin asumir la causa.",
              "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
              "",
              "CONTINUIDAD_CONVERSACIONAL:",
              "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
              "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
              "- Evita respuestas que solo informen el precio sin invitar a continuar.",
            ].join("\n");

            const aiNoPricePolicyReply = await answerWithPromptBase({
              tenantId,
              promptBase,
              userInput,
              history: [],
              idiomaDestino,
              canal,
              maxLines: 6,
              fallbackText:
                idiomaDestino === "en"
                  ? `We do offer ${targetServiceName}, but I don't currently have a price available for that service.`
                  : `Sí ofrecemos ${targetServiceName}, pero ahora mismo no tengo un precio disponible para ese servicio.`,
              extraContext,
            });

            return {
              handled: true,
              reply: aiNoPricePolicyReply.text,
              source: "price_fastpath_db_no_price_llm_render",
              intent: "precio",
              ctxPatch: {
                last_service_id: targetServiceId,
                last_service_name: targetServiceName || null,
                last_service_at: Date.now(),
              } as Partial<FastpathCtx>,
            };
          }

          if (matchedRow) {
            const min = matchedRow.min_price === null ? null : Number(matchedRow.min_price);
            const max = matchedRow.max_price === null ? null : Number(matchedRow.max_price);

            const hasExplicitServicePrice =
              Number.isFinite(min) && Number.isFinite(max);

            if (!hasExplicitServicePrice) {
              console.log("[PRICE][single][LLM_RENDER] no_explicit_price", {
                targetServiceId,
                targetServiceName,
              });

              const extraContext = [
                "PRECIO_DB_RESUELTO:",
                `- service_name: ${targetServiceName}`,
                `- pricing_mode: no_explicit_price`,
                `- source_of_truth: database`,
                "",
                "REGLAS_CRITICAS_DEL_TURNO:",
                "- El servicio sí existe en DB.",
                "- En este turno NO existe un precio explícito utilizable para este servicio.",
                "- NO puedes inventar montos, rangos ni precios aproximados.",
                "- NO puedes mencionar otros servicios como alternativa de precio, a menos que el usuario los pida.",
                "- Responde de forma natural, útil y comercial, manteniéndote en el servicio resuelto.",
                "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
                "",
                "CONTINUIDAD_CONVERSACIONAL:",
                "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
                "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
                "- Evita respuestas que solo informen el precio sin invitar a continuar.",
              ].join("\n");

              const aiNoPriceReply = await answerWithPromptBase({
                tenantId,
                promptBase,
                userInput,
                history: [],
                idiomaDestino,
                canal,
                maxLines: 6,
                fallbackText:
                  idiomaDestino === "en"
                    ? `We do offer ${targetServiceName}, but I don't currently have an explicit price configured for that service.`
                    : `Sí ofrecemos ${targetServiceName}, pero ahora mismo no tengo un precio explícito configurado para ese servicio.`,
                extraContext,
              });

              return {
                handled: true,
                reply: aiNoPriceReply.text,
                source: "price_fastpath_db_no_price_llm_render",
                intent: "precio",
                ctxPatch: {
                  last_service_id: targetServiceId,
                  last_service_name: targetServiceName || null,
                  last_service_at: Date.now(),
                } as Partial<FastpathCtx>,
              };
            }

            const priceText =
              min === max
                ? `$${min!.toFixed(2)}`
                : `${idiomaDestino === "en" ? "from" : "desde"} $${min!.toFixed(2)}`;

            console.log("[PRICE][single][LLM_RENDER] service_price", {
              targetServiceId,
              targetServiceName,
              min,
              max,
            });

            const extraContext = [
              "PRECIO_DB_RESUELTO:",
              `- service_name: ${targetServiceName}`,
              `- pricing_mode: ${min === max ? "fixed" : "from_price"}`,
              `- min_price: ${min ?? ""}`,
              `- max_price: ${max ?? ""}`,
              `- source_of_truth: database`,
              "",
              "REGLAS_CRITICAS_DEL_TURNO:",
              "- Debes responder usando EXCLUSIVAMENTE estos datos resueltos desde DB.",
              "- NO puedes inventar otros precios, rangos, variantes ni servicios alternativos.",
              "- NO puedes mezclar este servicio con otros del catálogo.",
              "- Si mencionas el precio, debe corresponder únicamente al servicio resuelto.",
              "- Redacta de forma natural, humana, breve y comercial para WhatsApp.",
              "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
              "",
              "CONTINUIDAD_CONVERSACIONAL:",
              "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
              "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
              "- Evita respuestas que solo informen el precio sin invitar a continuar.",
            ].join("\n");

            const aiServicePriceReply = await answerWithPromptBase({
              tenantId,
              promptBase,
              userInput,
              history: [],
              idiomaDestino,
              canal,
              maxLines: 6,
              fallbackText:
                idiomaDestino === "en"
                  ? `${targetServiceName} costs ${priceText}.`
                  : `${targetServiceName} cuesta ${priceText}.`,
              extraContext,
            });

            return {
              handled: true,
              reply: aiServicePriceReply.text,
              source: "price_fastpath_db_llm_render",
              intent: "precio",
              ctxPatch: {
                last_service_id: targetServiceId,
                last_service_name: targetServiceName || null,
                last_service_at: Date.now(),
              } as Partial<FastpathCtx>,
            };
          }
        }

        const rowsPrioritized = [...rows].sort((a, b) => {
          const aRole = normalizeCatalogRole(a.catalog_role);
          const bRole = normalizeCatalogRole(b.catalog_role);

          const aPrimary = aRole === "primary";
          const bPrimary = bRole === "primary";

          if (aPrimary !== bPrimary) {
            return aPrimary ? -1 : 1;
          }

          const aSortPrice =
            a.min_price === null ? Number.NEGATIVE_INFINITY : Number(a.min_price);
          const bSortPrice =
            b.min_price === null ? Number.NEGATIVE_INFINITY : Number(b.min_price);

          if (aSortPrice !== bSortPrice) {
            return bSortPrice - aSortPrice;
          }

          return String(a.service_name || "").localeCompare(String(b.service_name || ""));
        });

        let rowsLocalized = rowsPrioritized;

        if (idiomaDestino === "en") {
          rowsLocalized = await Promise.all(
            rowsPrioritized.map(async (r) => {
              const nameEs = String(r.service_name || "").trim();
              if (!nameEs) return r;

              try {
                const nameEn = await traducirTexto(nameEs, "en", "catalog_label");
                return { ...r, service_name: nameEn };
              } catch {
                return r;
              }
            })
          );
        }

        const dbReply = renderGenericPriceSummaryReply({
          lang: idiomaDestino,
          rows: rowsLocalized,
        });

        const cleanedReply = stripLinkSentences(dbReply);
        const canonicalReply = humanizeListReply(cleanedReply, idiomaDestino);
        const namesShown = extractPlanNamesFromReply(cleanedReply);

        const extraContext = [
          "CATALOGO_DB_CANONICO:",
          canonicalReply,
          "",
          "REGLAS_CRITICAS_DEL_TURNO:",
          "- Debes usar EXCLUSIVAMENTE los servicios y precios del CATALOGO_DB_CANONICO.",
          "- Debes conservar EXACTAMENTE el mismo orden de los bullets.",
          "- Debes conservar EXACTAMENTE los mismos nombres de servicios.",
          "- Debes conservar EXACTAMENTE los mismos precios.",
          "- NO puedes agregar servicios.",
          "- NO puedes quitar servicios.",
          "- NO puedes reordenar bullets.",
          "- NO puedes resumir varios bullets en uno solo.",
          "- SOLO puedes suavizar el encabezado o la línea final.",
          "- Si no puedes mejorar sin alterar el contenido, devuelve el CATALOGO_DB_CANONICO tal cual.",
          "- Si el usuario ya está en una conversación activa, NO empieces con saludo como 'Hola'. Ve directo al punto.",
          "",
          "CONTINUIDAD_CONVERSACIONAL:",
          "- La respuesta DEBE terminar con una pregunta o invitación a continuar la conversación.",
          "- Debes guiar al usuario hacia el siguiente paso (más información, reserva, o aclaración).",
          "- Evita respuestas que solo informen el precio sin invitar a continuar.",
        ].join("\n");

        const aiCatalogReply = await answerWithPromptBase({
          tenantId,
          promptBase,
          userInput,
          history: [],
          idiomaDestino,
          canal,
          maxLines: 8,
          fallbackText: canonicalReply,
          extraContext,
        });

        const modelReply = String(aiCatalogReply?.text || "").trim();
        const finalReply =
          modelReply && sameBulletStructure(canonicalReply, modelReply)
            ? modelReply
            : canonicalReply;

        console.log("[PRICE][catalog_db][SAFE_RENDER]", {
          rowsCount: rowsLocalized.length,
          namesShown,
          usedModelReply: finalReply === modelReply,
          canonicalPreview: canonicalReply.slice(0, 220),
          modelPreview: modelReply.slice(0, 220),
        });

        const ctxPatch: Partial<FastpathCtx> = {
          last_catalog_at: Date.now(),
        };

        if (namesShown.length) {
          ctxPatch.last_catalog_plans = namesShown;
        }

        console.log("[PRICE][catalog_db][FINAL_REPLY_BEFORE_RETURN]", {
          replyPreview: finalReply,
        });

        return {
          handled: true,
          reply: finalReply,
          source: "catalog_db",
          intent: "precio",
          ctxPatch,
        };
      }

      if (!asksSchedules && questionType === "other_plans") {
        const { rows } = await pool.query<CatalogVariantRow>(`
          SELECT
            CASE
              WHEN v.variant_name IS NOT NULL AND length(trim(v.variant_name)) > 0
                THEN s.name || ' — ' || v.variant_name
              ELSE s.name
            END AS option_name,
            s.name AS service_name,
            v.variant_name,
            v.price::numeric AS price_value
          FROM services s
          JOIN service_variants v
            ON v.service_id = s.id
          AND v.active = true
          WHERE s.tenant_id = $1
            AND s.active = true
            AND v.price IS NOT NULL

          UNION ALL

          SELECT
            s.name AS option_name,
            s.name AS service_name,
            NULL::text AS variant_name,
            s.price_base::numeric AS price_value
          FROM services s
          WHERE s.tenant_id = $1
            AND s.active = true
            AND s.price_base IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM service_variants v
              WHERE v.service_id = s.id
                AND v.active = true
                AND v.price IS NOT NULL
            )
          ORDER BY price_value ASC NULLS LAST, option_name ASC
        `, [tenantId]);

        const norm = (s: string) =>
          String(s || "")
            .trim()
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "");

        const prevSet = new Set(
          (prevFresh ? prevNames : []).map(norm)
        );

        const freshRows = rows.filter((r) => {
          const optionNorm = norm(r.option_name);
          const serviceNorm = norm(r.service_name);

          return !prevSet.has(optionNorm) && !prevSet.has(serviceNorm);
        });

        const rowsToRender: CatalogVariantRow[] = freshRows.slice(0, 5);

        if (!rowsToRender.length) {
          const reply =
            idiomaDestino === "en"
              ? "I already showed you the main options. You can ask me about any of the options I mentioned and I’ll gladly give you more details 😊"
              : "Ya te mostré las opciones principales. Puedes preguntarme por alguna de las opciones que te mencioné y con gusto te doy más detalles 😊";

          return {
            handled: true,
            reply,
            source: "catalog_db",
            intent: "precio",
            ctxPatch: {
              last_catalog_at: Date.now(),
            },
          };
        }

        let rowsLocalized = rowsToRender.map((r) => ({ ...r }));

        if (idiomaDestino === "en") {
          rowsLocalized = await Promise.all(
            rowsToRender.map(async (r) => {
              try {
                const optionEn = await traducirTexto(String(r.option_name || ""), "en", "catalog_label");
                return { ...r, option_name: optionEn };
              } catch {
                return r;
              }
            })
          );
        }

        const reply = renderVariantOptionsReply({
          lang: idiomaDestino,
          rows: rowsLocalized,
        });

        const namesShown = rowsToRender
          .map((r) => String(r.option_name || "").trim())
          .filter(Boolean)
          .slice(0, 7);

        const ctxPatch: Partial<FastpathCtx> = {
          last_catalog_at: Date.now(),
        };

        if (namesShown.length) {
          ctxPatch.last_catalog_plans = namesShown;
        }

        return {
          handled: true,
          reply,
          source: "catalog_db",
          intent: "precio",
          ctxPatch,
        };
      }

      console.log("[PRICE][pre-llm-catalog-check]", {
        userInput,
        detectedIntent,
        isPriceQuestion: isPriceQuestion(userInput, convoCtx),
        ellipticPriceFollowup: isEllipticPriceFollowup(userInput, convoCtx),
        last_service_id: convoCtx?.last_service_id ?? null,
        last_service_name: convoCtx?.last_service_name ?? null,
        last_variant_name: convoCtx?.last_variant_name ?? null,
      });

      const systemMsg =
        idiomaDestino === "en"
          ? `
      You are Aamy, a sales assistant for a multi-tenant SaaS.

      You receive:
      - A META section with high-level tags.
      - Optionally a PREVIOUS_PLANS_MENTIONED line.
      - The client's question.
      - A CATALOG text for this business, built from the "services" and "service_variants" tables.
      - Optionally, a BUSINESS_GENERAL_INFO block with general information such as business hours, address, schedules, etc.

      META TAGS:
      - QUESTION_TYPE can be "combination_and_price", "price_or_plan", or "other_plans".
      - HAS_MULTI_ACCESS_PLAN is "yes" if the catalog text clearly contains at least one plan/pass/bundle that gives access to multiple services/categories or to "all"/"any"; otherwise "no".
      - PREVIOUS_PLANS_MENTIONED tells you which plans have ALREADY been described. If "none", ignore it; otherwise avoid repeating them unless necessary.

      GLOBAL RULES:
      - Answer ONLY using information found in the CATALOG and BUSINESS_GENERAL_INFO blocks.
      - Do NOT invent prices, services, bundles or conditions.
      - Be clear, natural, and concise.
      - Intro lines:
        - You may use up to TWO very short intro lines (greeting + context) ONLY if PREVIOUS_PLANS_MENTIONED is "none".
        - If PREVIOUS_PLANS_MENTIONED is NOT "none" (follow-up questions), you MUST NOT include any greeting or intro line. Start directly with the list or detail.
      - Apart from those intro lines (when allowed) and an optional closing question/CTA, EVERYTHING must be bullet-listed.
      - NEVER write long paragraphs.

      IMPORTANT FORMAT RULE:
      - For each plan/service/product you MUST write EXACTLY ONE line:
        • “• Plan name: price summary”
      - After the colon ":" you may include ONLY a short price summary:
        - numbers,
        - currency symbols,
        - short terms like “from”, “per”, “USD/month”, “USD for 7 days”,
        - short conditions like “(autopay, 3 months)”.
      - It is FORBIDDEN to add descriptive text such as: access, unlimited, classes, during, ideal for, includes, suitable for, etc.
      - If the catalog contains a plan name followed by a long description, extract ONLY:
        - the name,
        - the price.
      - Benefits/inclusions can ONLY be used later in DETAIL MODE.

      QUANTITY RULE (MANDATORY):
      - In LISTING MODE, you MUST show ONLY 3 to 7 options.
      - It is STRICTLY FORBIDDEN to list all catalog items.
      - If the catalog contains more than 7 items, select only the most relevant:
        - representative price points,
        - most common plans,
        - or those best matching the user's intent.
      - NEVER show more than 7 bullets.
      - If a plan has multiple variants (autopay vs monthly, etc.), show ONLY ONE in the initial list. Other variants can only be shown if the client asks about that specific plan.

      NEUTRAL LIST INTRO:
      - When listing plans, NEVER say “Main plans”, “Featured plans”, “All plans”, etc.
      - ALWAYS use a neutral phrase indicating these are partial options:
        - “Some of our plans:”
        - “Here are a few options:”
        - “A few choices below:”
      - NEVER imply the list is exhaustive.

      HANDLING TIMES & SCHEDULES:
      - Business hours and general schedules appear in BUSINESS_GENERAL_INFO.
      - You may use explicit times from BUSINESS_GENERAL_INFO.
      - DO NOT generalize or invent ranges.
      - If BUSINESS_GENERAL_INFO contains multiple time slots, copy them EXACTLY as bullet points (one per line).
      - If there are NO explicit times, you may add ONE generic line without time-of-day words, for example:
        - Do NOT mention schedules or hours at all.
      - If CATALOG mentions time restrictions, treat them ONLY as plan-specific restrictions.

      LISTING MODE:
      - Use LISTING MODE when the user asks generically (“plans?”, “options?”, “plans and schedules?”).
      - In LISTING MODE:
        - Max 3–7 bullets.
        - EXACT format: “• Plan name: price summary”.
        - No descriptions allowed.
        - Only ONE link, for the most relevant option.
        - No paragraphs.
      - HANDLING PREVIOUS_PLANS_MENTIONED:
      - If PREVIOUS_PLANS_MENTIONED is not "none", you MUST treat this as a follow-up question like "what other plans do you have?".
      - In that case:
        - FIRST, try to list ONLY plans/passes/products that are NOT in PREVIOUS_PLANS_MENTIONED.
        - Select 3–7 items among those “new” plans, following the quantity rules.
        - If there are fewer than 3 new items available, you may:
          - list all remaining new ones, and
          - optionally add 1–2 previously mentioned plans, clearly marking that they were already mentioned.
      - Under no circumstances should you repeat exactly the same list of plans as before when PREVIOUS_PLANS_MENTIONED includes those items.
      - PRICE / PLAN QUESTIONS:
        - Always list plans in bullet format.
        - If several options are relevant, compare them using separate bullets.
        - When you list several options, you MUST order them from the lowest total price to the highest total price.
        - Plans or products with price 0 must be written as "free" (for example: "free" instead of "0 USD" or "0.00").

      DETAIL MODE:
      - Use DETAIL MODE only when the user asks about ONE specific plan.
      - STILL use bullets:
        - one bullet with name + price,
        - 1–3 sub-bullets with key details.
      - Keep it compact.

      PRICE / PLAN QUESTIONS:
      - Always list plans in bullet format.
      - If several options are relevant, compare them using separate bullets.
      
      COMBINATIONS / BUNDLES:
      - If QUESTION_TYPE is "combination_and_price" AND HAS_MULTI_ACCESS_PLAN is "yes":
        - You MUST recommend at least one plan that covers multiple services/categories or unlimited usage.
        - Mention name + price + URL if available.
      - If HAS_MULTI_ACCESS_PLAN is "no":
        - You may list individual services separately (in bullets).

      OUTPUT LANGUAGE:
      - Answer always in English.
      `.trim()
          : `
      Eres Aamy, asistente de ventas de una plataforma SaaS multinegocio.

      Recibes:
      - Una sección META con etiquetas de alto nivel.
      - Opcionalmente una línea PREVIOUS_PLANS_MENTIONED.
      - La pregunta del cliente.
      - Un texto de CATALOGO del negocio (services + service_variants).
      - Opcionalmente, un bloque INFO_GENERAL_DEL_NEGOCIO con horarios, dirección, etc.

      ETIQUETAS META:
      - QUESTION_TYPE puede ser "combination_and_price", "price_or_plan" o "other_plans".
      - HAS_MULTI_ACCESS_PLAN es "yes" si el catálogo contiene un plan/pase que dé acceso a varias categorías o a “todos”; si no, "no".
      - PREVIOUS_PLANS_MENTIONED indica qué planes YA se mencionaron.

      REGLAS GENERALES:
      - Responde SOLO con la información de CATALOGO e INFO_GENERAL_DEL_NEGOCIO.
      - NO inventes precios, servicios ni condiciones.
      - Líneas de introducción:
        - Solo puedes usar HASTA DOS líneas muy cortas al inicio (saludo + contexto) cuando PREVIOUS_PLANS_MENTIONED sea "none".
        - Si PREVIOUS_PLANS_MENTIONED NO es "none" (es decir, ya se mencionaron planes antes y la pregunta es un seguimiento), está PROHIBIDO usar saludo o introducción. Debes empezar directamente con la lista o el detalle.
      - Cada una de esas líneas (cuando estén permitidas) debe ser muy corta (1 oración); no escribas párrafos de bienvenida.
      - PROHIBIDO escribir párrafos largos.

      FORMATO DE PLANES (OBLIGATORIO):
      - Cada plan/pase/producto debe ir en UNA sola línea:
        • “• Nombre del plan: resumen de precio”.
      - Después de ":" SOLO puede ir un resumen de precio:
        - números,
        - símbolo de moneda,
        - palabras muy cortas: “desde”, “por”, “USD/mes”, “USD por 7 días”,
        - condiciones cortas: “(Autopay, 3 meses)”, “(sin compromiso)”.
      - PROHIBIDO agregar descripciones:
        - “acceso”, “ilimitado”, “clases”, “durante”, “ideal para…”, etc.
      - Si el nombre del plan viene con descripción, usa SOLO:
        - nombre,
        - precio.
      - Los beneficios/inclusiones SOLO se pueden mencionar en MODO DETALLE.

      REGLA DE CANTIDAD (OBLIGATORIA):
      - En MODO LISTA solo se pueden mostrar entre 3 y 7 opciones.
      - Está TOTALMENTE PROHIBIDO listar TODO el catálogo.
      - Si hay más de 7, elige solo las opciones más relevantes:
        - precios representativos,
        - planes más comunes,
        - o los que responden mejor a la intención del usuario.
      - JAMÁS muestres más de 7 ítems.
      - Si un plan tiene varias variantes (Autopay / Mensual / Paquete), SOLO muestra UNA.
      - Otras variantes solo pueden mostrarse si el cliente pregunta específicamente por ese plan.

      FRASES NEUTRAS PARA LISTAS:
      - NO digas “Planes principales”, “Planes destacados”, “Todos los planes”, etc.
      - Debes usar SIEMPRE frases neutras que indiquen que solo muestras una parte:
        - “Algunos de nuestros planes:”
        - “Aquí tienes algunas opciones:”
        - “Estas son algunas alternativas:”
      - Nunca sugieras que la lista es completa.

      CÓMO MANEJAR HORARIOS:
      - Si INFO_GENERAL_DEL_NEGOCIO contiene horarios explícitos:
        - Cópialos EXACTAMENTE como lista, uno por línea.
        - PROHIBIDO resumir (“en varios horarios”, “de mañana a noche”).
      - Si NO contiene horarios:
        - NO menciones horarios ni hagas comentarios genéricos sobre horarios.
      - Si el CATALOGO tiene restricciones horarias, aplícalas SOLO a ese plan.

      MODO LISTA:
      - Se usa cuando la pregunta es general.
      - Debes:
        - mostrar 3–7 opciones,
        - usar exactamente “• Nombre del plan: precio”,
        - NO poner descripciones,
        - NO poner variantes extras,
        - NO poner párrafos,
        - incluir SOLO UN enlace (si aplica).
      - MANEJO DE PREVIOUS_PLANS_MENTIONED:
        - Si PREVIOUS_PLANS_MENTIONED no es "none", debes entender que el cliente está pidiendo "otros planes" o un seguimiento.
        - En ese caso:
          - PRIMERO intenta listar SOLO planes/pases/productos que NO aparezcan en PREVIOUS_PLANS_MENTIONED.
          - Elige entre 3 y 7 de esos planes “nuevos”, respetando las reglas de cantidad.
          - Si hay menos de 3 planes nuevos disponibles:
            - muestra todos los nuevos,
            - y solo si es necesario añade 1–2 planes que ya se mencionaron, dejando claro que ya se habían comentado antes.
        - Bajo ninguna circunstancia debes repetir exactamente la misma lista de planes que ya se mostró cuando PREVIOUS_PLANS_MENTIONED contiene esos mismos nombres.
      - PRECIOS / SERVICIOS:
        - Siempre usa listas.
        - Comparaciones → una viñeta por opción.
        - Cuando muestres varias opciones, DEBES ordenarlas de menor a mayor precio total.
        - Si un plan o producto tiene precio 0, debes escribir "gratis" (por ejemplo: "gratis" en lugar de "0 USD" o "0.00").

      MODO DETALLE:
      - Se usa cuando el cliente pide info de un plan específico.
      - Igual en viñetas:
        - una línea principal con nombre + precio,
        - 1–3 subviñetas con detalles concretos.
      - Sin párrafos largos.

      PRECIOS / SERVICIOS:
      - Siempre usa listas.
      - Comparaciones → una viñeta por opción.

      COMBINADOS / PAQUETES:
      - Si QUESTION_TYPE = "combination_and_price" y HAS_MULTI_ACCESS_PLAN = "yes":
        - Debes recomendar un plan que cubra varias categorías o acceso amplio.
        - Incluye precio y URL si está en catálogo.
      - Si HAS_MULTI_ACCESS_PLAN = "no":
        - Puedes listar servicios individuales.

      IDIOMA DE SALIDA:
      - Responde siempre en español.
      `.trim();

      const userMsg =
        idiomaDestino === "en"
          ? `
META:
${metaBlock}

CLIENT QUESTION:
${userInput}

CATALOG:
${catalogText}${infoGeneralBlock}
`.trim()
          : `
META:
${metaBlock}

PREGUNTA DEL CLIENTE:
${userInput}

CATALOGO:
${catalogText}${infoGeneralBlock}
`.trim();

      const rawReply = await answerCatalogQuestionLLM({
        idiomaDestino,
        systemMsg,
        userMsg,
      });

      // 🔁 POST-PROCESO: quitar planes ya mencionados si la pregunta es "otros planes"
      const { finalReply, namesShown } = postProcessCatalogReply({
        reply: rawReply,
        questionType,
        prevNames,
      });

      // 🔧 limpiamos frases de "enlace / links / comprar en los enlaces"
      const cleanedReply = stripLinkSentences(finalReply);

      // 🌎 NUEVO: aseguramos que TODO el catálogo salga en el idiomaDestino
      let localizedReply = cleanedReply;

      if (idiomaDestino === "en") {
        try {
          // tu helper actual: traducir TODO el bloque al inglés,
          // incluyendo nombres de planes/productos.
          localizedReply = await traducirTexto(cleanedReply, "en");
        } catch (e: any) {
          console.warn(
            "[FASTPATH][CATALOG] error traduciendo respuesta de catálogo:",
            e?.message || e
          );
        }
      }
      // si en el futuro agregas más idiomas, aquí puedes meter más ramas:
      // else if (idiomaDestino === "es") { ... }

      const ctxPatch: Partial<FastpathCtx> = {};
      if (namesShown.length) {
        ctxPatch.last_catalog_plans = namesShown;
        ctxPatch.last_catalog_at = Date.now();
      }

      return {
        handled: true,
        // usamos la versión traducida
        reply: humanizeListReply(localizedReply, idiomaDestino),
        source: "catalog_llm",
        intent: intentOut || "catalog",
        ctxPatch,
      };
    }
  }

  return { handled: false };
}