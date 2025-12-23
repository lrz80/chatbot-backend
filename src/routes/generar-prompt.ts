// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import crypto from "crypto";                 // (B) Cache por checksum (sha256)

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";

// ———————————————————————————————————————————————————
// (B) Cache en memoria por proceso
// Clave = sha256(tenant_id + idioma + funciones + info)
const promptCache = new Map<string, { value: string; at: number }>();
const keyOf = (tenantId: string, funciones: string, info: string, idioma: string) =>
  crypto.createHash("sha256").update(`${tenantId}::${idioma}::${funciones}::${info}`).digest("hex");

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

    if (!descripcion || !informacion || !idioma) {
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

    function normalizePlain(s: string) {
      return compact((s || "").replace(/\\n/g, "\n").replace(/\r/g, ""));
    }

    function titleize(label: string) {
      return label.trim();
    }

    function asSection(title: string, body: string) {
      const b = normalizePlain(body);
      if (!b) return "";
      return `${titleize(title)}:\n${b}`;
    }

    function stripModeLine(text: string) {
      // remueve la línea MODO_PROMPT: ... para que no “ensucie” el prompt final
      return (text || "").replace(/^MODO_PROMPT:\s*(ATENCION|ACTIVACION)\s*$/gmi, "").trim();
    }

    function detectPromptModeFromText(text: string) {
      const m = (text || "").match(/MODO_PROMPT:\s*(ATENCION|ACTIVACION)/i);
      return (m?.[1] || "ATENCION").toUpperCase();
    }

    // Detectar modo desde texto libre (Opción A)
    const mode = detectPromptModeFromText(`${funciones}\n${info}`);

    // Limpiar la línea MODO_PROMPT para que no aparezca en el prompt final
    const funcionesClean = stripModeLine(funciones);
    const infoClean = stripModeLine(info);

    // Opcional: si tu UI no mete bullets, puedes forzar bullets line-by-line:
    // Aquí NO transformo, solo dejo lo que el usuario puso.
    const funcionesBlock = asSection("Reglas y comportamiento del asistente", funcionesClean);
    const infoBlock      = asSection("Contexto y hechos del negocio", infoClean);

    const promptCoreParts = [
      "Debes seguir estrictamente el contexto y las reglas definidas abajo. No inventes información. Si falta un dato, dilo claramente y pide lo mínimo necesario.",
      "",
      `Negocio: ${nombreNegocio}`,
      `Idioma: ${idioma}`,
      "",
      infoBlock ? infoBlock : "",
      "",
      funcionesBlock ? funcionesBlock : "",
      "",
      ...(mode === "ACTIVACION"
        ? [
            "Objetivo del chat:",
            "- Explicar el servicio de forma simple",
            "- Resolver dudas frecuentes",
            "- Mantener la conversación activa",
            "- Guiar al usuario a activar o contratar el servicio",
            "",
            "Activación del servicio:",
            "- Solicitar: nombre del negocio y ciudad/país",
            "- Confirmar qué canal desea activar (WhatsApp, Instagram o Facebook)",
          ]
        : [
            "Objetivo del chat:",
            "- Atender mensajes entrantes 24/7",
            "- Resolver dudas frecuentes (servicios, horarios, ubicación, precios si existen)",
            "- Facilitar reservas o el siguiente paso (enlace oficial o llamada)",
            "- Capturar el motivo del cliente y los datos mínimos",
            "",
            "Seguimiento:",
            "- Si el cliente no responde, realizar seguimiento (máximo 2 intentos) dentro de 23 horas",
            "- Si el cliente responde, detener el seguimiento",
          ]),

    ].filter(Boolean);

    const prompt = compact(promptCoreParts.join("\n"));

    // (A) Anexar bloque de enlaces oficiales + política de uso (formato texto plano)
    const bloqueEnlaces = enlacesOficiales.length
      ? ["=== ENLACES_OFICIALES ===", ...enlacesOficiales.map((u) => `- ${u}`)].join("\n")
      : "=== ENLACES_OFICIALES ===\n(Sin URLs detectadas en la información del negocio).";

    const politicaEnlaces = [
      "=== POLITICA_DE_ENLACES ===",
      '- Comparte ÚNICAMENTE URLs listadas en "ENLACES_OFICIALES".',
      "- Si mencionas precios, horarios, reservas o políticas, incluye 1 URL pertinente del listado (si existe).",
      "- No inventes, no uses acortadores, y pega la URL completa (formato texto plano).",
      "- Si necesitas un enlace y no está en la lista, indica amablemente que no puedes confirmarlo desde aquí.",
    ].join("\n");

    const promptFinal = [prompt, "", bloqueEnlaces, "", politicaEnlaces].join("\n");

    // (B) Guarda en cache para futuras llamadas idénticas
    promptCache.set(cacheKey, { value: promptFinal, at: Date.now() });

    res.status(200).json({ prompt: promptFinal });
  } catch (err) {
    console.error("❌ Error generando prompt:", err);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

export default router;
