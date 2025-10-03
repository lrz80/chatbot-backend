// src/routes/generar-prompt.ts

import { Router, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../lib/db";
import OpenAI from "openai";                 // (D) Cliente OpenAI al scope de módulo (sin import dinámico)
import crypto from "crypto";                 // (B) Cache por checksum (sha256)

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret-key";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" }); // (D)

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

  // 3) de-dup por host+path
  const uniq = new Map<string, string>();
  for (const u of found) {
    try {
      const p = new URL(u);
      const key = `${p.hostname}${p.pathname}`;
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

    // (F) Normaliza saltos/espacios y compacta antes de mandar al modelo
    const funciones = compact(descripcion.replace(/\\n/g, "\n").replace(/\r/g, ""));
    const info = compact(informacion.replace(/\\n/g, "\n").replace(/\r/g, ""));

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

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini", // (A) Modelo rápido
      temperature: 0.4,
      max_tokens: 1200,                                 // (A) Límite razonable
      messages: [
        {
          role: "user",
          content: `Estoy creando un asistente en ${idioma}. Su nombre es Amy y nunca debe decir que no se llama Amy. Amy debe hablar como si fuera parte del equipo del negocio "${nombreNegocio}". Nunca debe responder en nombre de otro asistente o empresa.

Estas son sus funciones:
${funciones}

Esta es la información clave que debe conocer:
${info}

🔒 MODO HECHOS ESTRICTOS
- Responde EXCLUSIVAMENTE con información contenida en el bloque anterior. Si un dato (precio, horario, política, ubicación, etc.) no está, responde: "Lo siento, no tengo esa información disponible en este momento."
- Nunca inventes, completes ni supongas datos.
- Usa números, montos, horarios, nombres y textos tal como aparecen (sin alterarlos).

🧾 PROTOCOLO DE RESPUESTA (WhatsApp)
1) Si el usuario hace VARIAS preguntas, respóndelas TODAS en un solo mensaje, en bullets claros.
2) Mantén la respuesta corta (≤ 6 líneas si es posible). Puedes usar bullets y negritas para claridad.
3) Cuando menciones precios, horarios, reservas o políticas, pega **hasta 2 enlaces** pertinentes tomados únicamente de ENLACES_OFICIALES (máx. 1 por tema). Si no hay enlace pertinente listado, dilo amablemente.
4) Si el usuario pide algo que no está en los datos, usa la frase indicada y ofrece la acción disponible.
5) Idioma de salida: ${idioma}. Ve al grano, sin despedidas largas.

=== MODO VENDEDOR (ALTO DESEMPEÑO) ===
- Objetivo: convertir consultas en reservas o compras sin ser invasivo. Persuade con claridad, beneficios y próximos pasos.
- Enfoque: primero entender → luego proponer → cerrar con un CTA concreto.
- Nunca inventes beneficios, precios, cupos ni promociones. Usa EXCLUSIVAMENTE lo que esté en este prompt y ENLACES_OFICIALES.

1) Descubrimiento (máx. 1 línea)
- Haz 1 pregunta útil para perfilar necesidad/objetivo (p.ej., “¿Buscas cycling, funcional o ambas?”).
- Si el usuario ya lo dijo, NO repreguntes.

2) Beneficios y encaje
- Resalta 1–2 beneficios RELEVANTES a lo que pidió (extraídos del prompt). Evita genéricos.
        - Si mencionan “primera clase gratis”, refuérzala (“de cortesía”) como vía de entrada.

        3) Oferta y anclaje
        - Sugiere el plan/paquete MÁS adecuado según lo dicho (no sugieras planes que no existan).
        - Si preguntan por algo que NO existe (p.ej., plan para 2): dilo claramente y redirige al plan más cercano (según los datos).

        4) Urgencia ética
        - Usa urgencia ligera basada en hechos del prompt (p.ej., “recomendamos reservar con anticipación; los cupos se agotan”).
        - NO inventes escasez ni promociones.

        5) Cierre con CTA único y claro
        - Termina SIEMPRE con un paso accionable usando **solo enlaces de ENLACES_OFICIALES**:
          • Si el tema es reservas/horarios → elige 1 enlace pertinente de ENLACES_OFICIALES.
          • Si el tema es planes/precios → elige 1 enlace pertinente de ENLACES_OFICIALES.
          • Si el tema es “clase de cortesía” → elige 1 enlace pertinente de ENLACES_OFICIALES.
          • Si el tema es soporte → elige 1 enlace pertinente de ENLACES_OFICIALES.
        - Máximo 2 enlaces por respuesta (y 1 por tema). Si no hay enlace pertinente listado, indícalo amablemente.

        6) Manejo de objeciones (breve)
        - Precio: destaca packs/Autopay si aportan valor real (según el prompt).
        - Tiempo/horarios: remite al enlace pertinente de ENLACES_OFICIALES (si existe).
        - Dudas: ofrece soporte solo si lo piden o si es necesario, usando un enlace pertinente de ENLACES_OFICIALES (si existe).

        7) Tono
        - Cercano, profesional y proactivo. Sin presión. 2–3 líneas + CTA.

        Devuelve un único texto plano profesional, listo para usarse como prompt del sistema. No incluyas JSON ni instrucciones técnicas.`

        },
      ],
      });

    const prompt = completion.choices[0]?.message?.content?.trim();
    if (!prompt) return res.status(500).json({ error: "No se pudo generar el prompt" });

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
