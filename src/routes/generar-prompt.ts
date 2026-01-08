// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import crypto from "crypto";                 // (B) Cache por checksum (sha256)

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

// (B) Cache en memoria por proceso
// Clave = sha256(PROMPT_GEN_VERSION + tenant_id + idioma + funciones + info)
const PROMPT_GEN_VERSION = "v4"; // ⬅️ cambia esto cada vez que ajustes la lógica del generador

const promptCache = new Map<string, { value: string; at: number }>();

const keyOf = (tenantId: string, funciones: string, info: string, idioma: string) =>
  crypto
    .createHash("sha256")
    .update(`${PROMPT_GEN_VERSION}::${tenantId}::${idioma}::${funciones}::${info}`)
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
    if (url.pathname.endsWith('/') && url.pathname !== '/' && !url.hash) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // usar href para conservar hash tal cual
    return url.href;
  } catch {
    return u.trim();
  }
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
    if (value.trim()) kv[k].push(value.trim());
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Key: Value
    const m = line.match(/^([^:]{2,60}):\s*(.*)$/);
    if (m) {
      currentKey = m[1].trim();
      const v = (m[2] || "").trim();
      if (v) push(currentKey, v);
      continue;
    }

    // List item under current key
    if (currentKey) {
      // permite "- item" o "• item"
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

function buildOperationalBusinessContext(infoClean: string, nombreNegocio: string) {
  const kv = parseKeyValueTemplate(infoClean);

  // Detecta si realmente era una plantilla (tiene llaves tipo "Nombre del negocio", etc.)
  const hasTemplateSignals =
    Object.keys(kv).some(k =>
      /nombre del negocio|tipo de negocio|ubicaci[oó]n|servicios|horarios|precios|reservas|contacto/i.test(k)
    );

  if (hasTemplateSignals) {
    const nombre = (kv["Nombre del negocio"]?.[0] || nombreNegocio || "").trim();
    const tipo = (kv["Tipo de negocio"]?.[0] || "").trim();
    const ubic = (kv["Ubicación"]?.[0] || "").trim();
    const tel  = (kv["Teléfono"]?.[0] || "").trim();

    const servicios = kv["Servicios principales"] || kv["Servicios"] || [];
    const horarios  = kv["Horarios"] || [];
    const precios   = kv["Precios o cómo consultar precios"] || kv["Precios"] || [];
    const reservas  = kv["Reservas / contacto"] || kv["Reservas"] || kv["Contacto"] || [];

    const out: string[] = [];

    out.push("DATOS DEL NEGOCIO");
    out.push(...toBullets([
      nombre ? `Nombre: ${nombre}` : `Nombre: ${nombreNegocio}`,
      tipo ? `Tipo: ${tipo}` : "",
      ubic ? `Ubicación: ${ubic}` : "",
      tel ? `Teléfono: ${tel}` : "",
    ].filter(Boolean)));

    if (servicios.length) {
      out.push("");
      out.push("SERVICIOS");
      out.push(...toBullets(servicios));
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

    return compact(out.join("\n"));
  }

  // Fallback: si no era plantilla, lo compacta como bullets (sin inventar)
  const t = compact(infoClean || "");
  if (!t) return "";
  return compact(["CONOCIMIENTO DEL NEGOCIO", t].join("\n"));
}

function buildOperationalRules(funcionesClean: string) {
  const t = compact(funcionesClean || "");
  if (!t) return "";
  // Respeta el formato que escribió el usuario (prosa o bullets)
  return compact(["REGLAS Y COMPORTAMIENTO", t].join("\n"));
}

// ———————————————————————————————————————————————————

router.post("/", async (req: Request, res: Response) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Token requerido" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    const tenant_id = decoded.tenant_id;
    const { descripcion, informacion, idioma } = req.body;

    // (E) Límite de entrada (para evitar prompts kilométricos)
    const MAX = 14_000; // caracteres
    const descripcionCapped = (descripcion || "").slice(0, MAX);
    const informacionCapped = (informacion || "").slice(0, MAX);

    // (F) Normaliza saltos/espacios y compacta antes de mandar al modelo
    const funciones = compact(descripcionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));
    const info      = compact(informacionCapped.replace(/\\n/g, "\n").replace(/\r/g, ""));

    if (!funciones || !info || !idioma) {
      return res.status(400).json({ error: "Faltan campos requeridos" });
    }

    const tenantRes = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenant_id]);
    const tenant = tenantRes.rows[0];
    if (!tenant) return res.status(404).json({ error: "Negocio no encontrado" });

    if (!tenant.membresia_activa) {
      return res.status(403).json({ error: "Membresía inactiva. Actívala para generar prompts." });
    }

    const nombreNegocio = tenant.name || "nuestro negocio";

    // (B) Cache hit?
    const cacheKey = keyOf(tenant_id, funciones, info, idioma);
    const hit = promptCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 1000 * 60 * 60 * 12) { // 12 horas
      return res.status(200).json({ prompt: hit.value });
    }

    // Logs livianos (C)
    console.log("📤 Generar prompt:", {
      negocio: nombreNegocio,
      idioma,
      funciones_chars: funciones.length,
      info_chars: info.length,
    });

    // (A) URLs oficiales desde el propio contenido
    const enlacesOficiales = extractAllLinksFromText(`${funciones}\n\n${info}`, 24);

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

    // Opcional: si tu UI no mete bullets, puedes forzar bullets line-by-line:
    // Aquí NO transformo, solo dejo lo que el usuario puso.
    const infoOperativo = buildOperationalBusinessContext(infoClean, nombreNegocio);
    const reglasOperativas = buildOperationalRules(funcionesClean);

    const infoBlock = infoOperativo ? infoOperativo : "";
    const funcionesBlock = reglasOperativas ? reglasOperativas : "";

    const linksPolicy = enlacesOficiales.length
      ? [
          "POLITICA_DE_ENLACES",
          "- Comparte únicamente URLs listadas en ENLACES_OFICIALES.",
          "- No inventes links ni uses acortadores.",
        ].join("\n")
      : "";

    const linksBlock = enlacesOficiales.length
      ? ["ENLACES_OFICIALES", ...enlacesOficiales.map((u) => `- ${u}`)].join("\n")
      : "";

    const promptCoreParts = [
      // Identidad primero (siempre)
      `Eres Amy, el asistente virtual de ${nombreNegocio}.`,
      "Atiendes conversaciones con clientes reales y respondes de forma profesional, clara y humana.",
      "",
      `Idioma: ${idioma}`,
      "",

      // Contexto del negocio (lo que “sabe”)
      infoBlock ? "CONTEXTO DEL NEGOCIO" : "",
      infoBlock ? infoBlock : "",
      "",

      // Comportamiento (lo que “hace”)
      funcionesBlock ? "COMPORTAMIENTO Y ESTILO" : "",
      funcionesBlock ? funcionesBlock : "",
      "",

      // Reglas universales (pero en tono natural, no “manual interno”)
      "REGLAS",
      "- No inventes información.",
      "- Si falta un dato importante, pide solo lo mínimo.",
      "- Mantén respuestas breves y claras; haz una sola pregunta a la vez.",
      "- Evita repetir textos literalmente; si necesitas confirmar un dato, hazlo en una frase distinta y breve.",
      "",

      // Links solo si existen
      linksPolicy ? linksPolicy : "",
      linksBlock ? linksBlock : "",
    ].filter(Boolean);


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
