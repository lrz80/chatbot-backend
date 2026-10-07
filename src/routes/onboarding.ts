// src/routes/onboarding.ts
//
// Onboarding de Aamy.
// - POST /api/onboarding/analyze-website  -> lee el sitio y devuelve una PROPUESTA (no guarda nada)
// - POST /api/onboarding/assign-number    -> asigna un número de voz de prueba (con candados)
// - POST /api/onboarding/complete         -> marca onboarding_completado = true
//
// El guardado real de la propuesta lo hace el front con el PATCH /api/settings que ya existe.

import express, { Response } from "express";
import dns from "dns/promises";
import net from "net";

import twilio from "twilio";

import pool from "../lib/db";
import { authenticateUser, AuthenticatedRequest } from "../middleware/auth";
import { ensureTwilioSubaccountForTenant } from "../lib/twilio/ensureTwilioSubaccountForTenant";

const router = express.Router();

const OPENAI_MODEL = process.env.OPENAI_ONBOARDING_MODEL || "gpt-4o-mini";
const MAX_PAGES = 4;
const MAX_CHARS_PER_PAGE = 6000;
const MAX_BYTES_PER_PAGE = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Acceso al onboarding.
 * - Admin: siempre.
 * - Dueño de negocio (cliente): solo si ONBOARDING_OPEN_TO_OWNERS=true en el servidor,
 *   y siempre sobre SU propio negocio (req.user.tenant_id).
 */
const OPEN_TO_OWNERS = process.env.ONBOARDING_OPEN_TO_OWNERS === "true";

function requireOnboardingAccess(req: AuthenticatedRequest, res: Response): boolean {
  if (req.user?.is_admin) return true;
  if (OPEN_TO_OWNERS && req.user?.tenant_id) return true;
  res.status(403).json({ error: "El onboarding todavía no está habilitado para clientes" });
  return false;
}

/* ───────────────────────── Límites de uso (en memoria) ─────────────────────────
 * Primera capa de protección. Se reinicia cuando el servidor se reinicia.
 * Los admin no tienen estos límites.
 */
const usage = new Map<string, number[]>();
const inFlightNumbers = new Set<string>();

function recentCount(key: string, windowMs: number): number {
  const now = Date.now();
  const recent = (usage.get(key) || []).filter((t) => now - t < windowMs);
  usage.set(key, recent);
  return recent.length;
}

function recordUse(key: string): void {
  const list = usage.get(key) || [];
  list.push(Date.now());
  usage.set(key, list);
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_ANALYZE_PER_HOUR = 10;
const MAX_NUMBER_ATTEMPTS_PER_HOUR = 3;
const MAX_NUMBERS_PER_DAY = Number(process.env.ONBOARDING_MAX_NUMBERS_PER_DAY || 20);

/* ───────────────────────── Seguridad: evitar SSRF ───────────────────────── */

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return (
      v === "::1" ||
      v === "::" ||
      v.startsWith("fc") ||
      v.startsWith("fd") ||
      v.startsWith("fe80") ||
      v.startsWith("::ffff:127.") ||
      v.startsWith("::ffff:10.") ||
      v.startsWith("::ffff:192.168.")
    );
  }
  return true;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL inválida");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("La URL debe iniciar con http:// o https://");
  }
  const host = url.hostname;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("URL no permitida");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("URL no permitida");
    return url;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some((r) => isPrivateIp(r.address))) {
    throw new Error("URL no permitida");
  }
  return url;
}

/* ───────────────────────── Lectura del sitio ───────────────────────── */

const BOT_UA = "AamyBot/1.0 (+https://aamy.ai) read-only business scan";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type FetchResult = { html: string | null; reason: string };

async function fetchPage(startUrl: string, userAgent: string): Promise<FetchResult> {
  let current = startUrl;

  for (let hop = 0; hop < 4; hop++) {
    let url: URL;
    try {
      url = await assertPublicUrl(current);
    } catch (e: any) {
      return { html: null, reason: `url bloqueada: ${e?.message}` };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const resp = await fetch(url.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "en-US,en;q=0.9,es;q=0.8",
        },
      });

      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (!loc) return { html: null, reason: `redirect ${resp.status} sin location` };
        current = new URL(loc, url).toString();
        continue;
      }

      if (!resp.ok) return { html: null, reason: `HTTP ${resp.status}` };

      const type = resp.headers.get("content-type") || "";
      if (!type.includes("text/html") && !type.includes("xhtml")) {
        return { html: null, reason: `content-type ${type || "vacio"}` };
      }

      const buf = await resp.arrayBuffer();
      const html = Buffer.from(buf).subarray(0, MAX_BYTES_PER_PAGE).toString("utf8");
      return { html, reason: "ok" };
    } catch (e: any) {
      return { html: null, reason: `error de red: ${e?.name || ""} ${e?.message || ""}`.trim() };
    } finally {
      clearTimeout(timer);
    }
  }
  return { html: null, reason: "demasiadas redirecciones" };
}

function htmlToText(html: string): string {
  // Teléfonos y correos que viven en links (tel: / mailto:)
  const tels = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  const mails = [...html.matchAll(/href=["']mailto:([^"'?]+)/gi)].map((m) => m[1]);
  const waNumbers = [
    ...[...html.matchAll(/wa\.me\/\+*(\d{8,15})/gi)].map((m) => m[1]),
    ...[...html.matchAll(/whatsapp\.com\/send\/?\?[^"']*phone=(?:\+|%2B|\s)*(\d{8,15})/gi)].map((m) => m[1]),
  ];

  // Datos estructurados (JSON-LD) suelen traer dirección y horarios limpios
  const jsonLd = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .join("\n")
    .slice(0, 3000);

  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim();
  const metaDesc =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)?.[1] ||
    "";

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CHARS_PER_PAGE);

  const extras = [
    title ? `TITULO: ${title}` : "",
    metaDesc ? `DESCRIPCION META: ${metaDesc}` : "",
    tels.length ? `TELEFONOS EN LINKS: ${[...new Set(tels)].join(", ")}` : "",
    waNumbers.length ? `WHATSAPP EN LINKS: ${[...new Set(waNumbers)].join(", ")}` : "",
    mails.length ? `CORREOS EN LINKS: ${[...new Set(mails)].join(", ")}` : "",
    jsonLd ? `DATOS ESTRUCTURADOS: ${jsonLd}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `${text}\n${extras}`.trim();
}

async function readWebsite(rootUrl: URL): Promise<{ text: string; pagesRead: string[] }> {
  const candidates = [
    rootUrl.toString(),
    new URL("/about", rootUrl).toString(),
    new URL("/about-us", rootUrl).toString(),
    new URL("/services", rootUrl).toString(),
    new URL("/contact", rootUrl).toString(),
  ];

  const chunks: string[] = [];
  const pagesRead: string[] = [];

  for (const pageUrl of candidates) {
    if (pagesRead.length >= MAX_PAGES) break;

    let result = await fetchPage(pageUrl, BOT_UA);
    if (!result.html) {
      // Algunos sitios bloquean bots: reintentar como navegador normal
      const retry = await fetchPage(pageUrl, BROWSER_UA);
      if (retry.html) result = retry;
    }

    if (!result.html) {
      console.log("[ONBOARDING][PAGE_SKIPPED]", { pageUrl, reason: result.reason });
      continue;
    }

    const text = htmlToText(result.html);
    if (text.length < 40) {
      console.log("[ONBOARDING][PAGE_EMPTY]", {
        pageUrl,
        htmlBytes: result.html.length,
        note: "poco texto: el sitio probablemente se arma con JavaScript",
      });
      continue;
    }

    pagesRead.push(pageUrl);
    chunks.push(`### PAGINA: ${pageUrl}\n${text}`);
  }

  return { text: chunks.join("\n\n"), pagesRead };
}

/* ───────────────────────── Propuesta con OpenAI ───────────────────────── */

const SYSTEM_PROMPT = `Eres un asistente que extrae información de negocios a partir del texto de su sitio web.
Devuelve SOLO un objeto JSON con exactamente estas llaves:
{
  "business_name": string | null,
  "category": string | null,
  "description": string | null,
  "phone": string | null,
  "address": string | null,
  "hours": {
    "mon": {"start":"HH:MM","end":"HH:MM"} | null,
    "tue": ..., "wed": ..., "thu": ..., "fri": ..., "sat": ..., "sun": ...
  },
  "services": string[],
  "policies": string | null
}
Reglas:
- Usa SOLO información que aparezca en el texto. Si algo no aparece, usa null (o [] en services). NUNCA inventes datos.
- Horas en formato 24h "HH:MM". Un día cerrado o desconocido es null.
- "description": 1 a 3 oraciones, en el mismo idioma del sitio.
- "services": lista corta y concreta.
- "policies": garantías, cancelaciones, pagos, cobertura o áreas de servicio si se mencionan.
- "business_name": usa el nombre comercial tal como aparece en el sitio (título, logo o encabezados), NO el dominio.
- "phone": si no hay un teléfono explícito pero hay un número de WhatsApp en los links, úsalo en formato +<código país><número>.
- No incluyas texto fuera del JSON.`;

type Proposal = {
  business_name: string | null;
  category: string | null;
  description: string | null;
  phone: string | null;
  address: string | null;
  hours: Record<string, { start: string; end: string } | null>;
  services: string[];
  policies: string | null;
};

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function cleanStr(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function normalizeProposal(raw: any): Proposal {
  const hours: Proposal["hours"] = {};
  for (const d of DAYS) {
    const h = raw?.hours?.[d];
    const ok =
      h &&
      typeof h.start === "string" &&
      typeof h.end === "string" &&
      /^\d{1,2}:\d{2}$/.test(h.start) &&
      /^\d{1,2}:\d{2}$/.test(h.end);
    hours[d] = ok ? { start: h.start, end: h.end } : null;
  }

  return {
    business_name: cleanStr(raw?.business_name),
    category: cleanStr(raw?.category),
    description: cleanStr(raw?.description),
    phone: cleanStr(raw?.phone),
    address: cleanStr(raw?.address),
    hours,
    services: Array.isArray(raw?.services)
      ? raw.services.map(cleanStr).filter(Boolean).slice(0, 25)
      : [],
    policies: cleanStr(raw?.policies),
  };
}

async function buildProposal(siteText: string): Promise<Proposal> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no está configurada");

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: siteText },
      ],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data: any = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "{}";
  return normalizeProposal(JSON.parse(content));
}

/* ───────────────────────── Rutas ───────────────────────── */

router.post(
  "/analyze-website",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireOnboardingAccess(req, res)) return;

    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: "Negocio no seleccionado" });
    }

    if (!req.user?.is_admin) {
      if (recentCount(`analyze:${tenantId}`, HOUR) >= MAX_ANALYZE_PER_HOUR) {
        return res.status(429).json({ error: "Demasiados intentos. Intenta de nuevo en un rato." });
      }
      recordUse(`analyze:${tenantId}`);
    }

    let website = typeof req.body?.website === "string" ? req.body.website.trim() : "";
    if (!website) {
      return res.status(400).json({ error: "Escribe el website del negocio" });
    }
    if (!/^https?:\/\//i.test(website)) website = `https://${website}`;

    try {
      const rootUrl = await assertPublicUrl(website);
      const { text, pagesRead } = await readWebsite(rootUrl);

      if (!text) {
        return res.status(422).json({
          error:
            "No pude leer ese sitio. Revisa que la dirección sea correcta y que la página sea pública.",
        });
      }

      const proposal = await buildProposal(text);

      console.log("[ONBOARDING][ANALYZE_OK]", {
        tenantId,
        website: rootUrl.toString(),
        pagesRead: pagesRead.length,
      });

      return res.status(200).json({
        ok: true,
        source_url: rootUrl.toString(),
        pages_read: pagesRead,
        proposal,
      });
    } catch (error: any) {
      console.error("[ONBOARDING][ANALYZE_FAILED]", {
        tenantId,
        message: error?.message,
      });

      const message = String(error?.message || "");
      if (message.includes("URL")) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({
        error: "No se pudo analizar el sitio. Intenta de nuevo.",
      });
    }
  }
);

router.post(
  "/assign-number",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireOnboardingAccess(req, res)) return;

    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: "Negocio no seleccionado" });
    }
    const isAdmin = req.user?.is_admin === true;

    const areaCode = String(req.body?.area_code ?? "").trim();
    if (areaCode && !/^[2-9]\d{2}$/.test(areaCode)) {
      return res.status(400).json({ error: "Código de área inválido. Usa 3 dígitos de EE. UU." });
    }

    // Evita compras dobles si el usuario toca el botón varias veces
    if (inFlightNumbers.has(tenantId)) {
      return res.status(409).json({ error: "Ya se está activando tu número. Espera un momento." });
    }
    inFlightNumbers.add(tenantId);

    try {
      const tenantRes = await pool.query(
        `SELECT id, name, twilio_number, twilio_voice_number, info_clave
           FROM tenants
          WHERE id = $1
          LIMIT 1`,
        [tenantId]
      );
      const tenant = tenantRes.rows[0];
      if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

      // Candado 1: un solo número de voz por negocio
      if (tenant.twilio_voice_number) {
        return res.status(200).json({
          ok: true,
          already_assigned: true,
          twilio_voice_number: tenant.twilio_voice_number,
        });
      }

      // Candado 2: la información del negocio ya debe estar guardada
      if (!String(tenant.info_clave || "").trim()) {
        return res.status(409).json({
          error: "Primero guarda la información del negocio en el paso Revisar.",
        });
      }

      if (!isAdmin) {
        // Candado 3: correo verificado
        const userRes = await pool.query(
          `SELECT verificado FROM users WHERE uid = $1 LIMIT 1`,
          [req.user?.uid]
        );
        if (!userRes.rows[0]?.verificado) {
          return res.status(403).json({ error: "Verifica tu correo antes de activar tu número." });
        }

        // Candado 4: límites de intentos y tope diario global
        if (recentCount(`number:${tenantId}`, HOUR) >= MAX_NUMBER_ATTEMPTS_PER_HOUR) {
          return res.status(429).json({ error: "Demasiados intentos. Intenta de nuevo más tarde." });
        }
        recordUse(`number:${tenantId}`);

        if (recentCount("number:global", DAY) >= MAX_NUMBERS_PER_DAY) {
          console.warn("[ONBOARDING][NUMBER_DAILY_CAP]", { tenantId });
          return res.status(503).json({
            error: "Hoy se alcanzó el límite de números de prueba. Intenta mañana o contacta a soporte.",
          });
        }
      }

      const webhookConfig = {
        voiceUrl: `${process.env.BACKEND_URL || "https://api.aamy.ai"}/webhook/voice-realtime`,
        voiceMethod: "POST" as const,
        statusCallback: `${process.env.BACKEND_URL || "https://api.aamy.ai"}/webhook/voice-status`,
        statusCallbackMethod: "POST" as const,
      };

      const account = await ensureTwilioSubaccountForTenant(tenant.id);
      const subClient = twilio(account.twilioSubaccountSid, account.twilioSubaccountAuthToken);

      let voiceNumber: string;

      if (tenant.twilio_number) {
        // Igual que /api/twilio/voice/setup: reutiliza el número de WhatsApp para voz
        const existing = (
          await subClient.incomingPhoneNumbers.list({ phoneNumber: tenant.twilio_number, limit: 1 })
        )[0];

        if (!existing) {
          return res.status(409).json({
            error: "El número guardado para este negocio no existe en su subcuenta Twilio.",
          });
        }

        const capabilities = (existing as any).capabilities;
        if (capabilities && capabilities.voice === false) {
          return res.status(409).json({
            error: "El número de WhatsApp de este negocio no admite llamadas de voz.",
          });
        }

        await subClient.incomingPhoneNumbers(existing.sid).update(webhookConfig);
        voiceNumber = tenant.twilio_number;
      } else {
        // Compra un número local de EE. UU. con Voice + SMS (opcionalmente en un código de área)
        const available = await subClient.availablePhoneNumbers("US").local.list({
          voiceEnabled: true,
          smsEnabled: true,
          ...(areaCode ? { areaCode: Number(areaCode) } : {}),
          limit: 1,
        });

        if (!available.length) {
          return res.status(409).json({
            error: areaCode
              ? `No hay números disponibles en el código de área ${areaCode}. Prueba con otro.`
              : "No hay números disponibles ahora mismo. Intenta de nuevo en unos minutos.",
          });
        }

        const purchased = await subClient.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
          ...webhookConfig,
        });

        voiceNumber = purchased.phoneNumber;
        recordUse("number:global");
      }

      await pool.query(`UPDATE tenants SET twilio_voice_number = $1 WHERE id = $2`, [
        voiceNumber,
        tenant.id,
      ]);

      console.log("[ONBOARDING][NUMBER_ASSIGNED]", {
        tenantId,
        by: isAdmin ? "admin" : "owner",
        areaCode: areaCode || null,
        reusedWhatsappNumber: Boolean(tenant.twilio_number),
      });

      return res.status(200).json({
        ok: true,
        already_assigned: false,
        twilio_voice_number: voiceNumber,
      });
    } catch (error: any) {
      console.error("[ONBOARDING][NUMBER_FAILED]", {
        tenantId,
        message: error?.message,
        code: error?.code,
      });
      return res.status(500).json({
        error: "No se pudo activar el número. Intenta de nuevo o contacta a soporte.",
      });
    } finally {
      inFlightNumbers.delete(tenantId);
    }
  }
);

router.post(
  "/complete",
  authenticateUser,
  async (req: AuthenticatedRequest, res: Response) => {
    if (!requireOnboardingAccess(req, res)) return;

    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      return res.status(401).json({ error: "Negocio no seleccionado" });
    }

    try {
      await pool.query(
        `UPDATE tenants
            SET onboarding_completado = true,
                updated_at = NOW()
          WHERE id = $1`,
        [tenantId]
      );
      return res.status(200).json({ ok: true });
    } catch (error: any) {
      console.error("[ONBOARDING][COMPLETE_FAILED]", { tenantId, message: error?.message });
      return res.status(500).json({ error: "No se pudo completar el onboarding" });
    }
  }
);

export default router;