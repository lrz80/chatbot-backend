// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import OpenAI from "openai";
import { detectarIdioma } from "../../lib/detectarIdioma";
import { traducirMensaje } from "../../lib/traducirMensaje";
import { getPromptPorCanal, getBienvenidaPorCanal } from "../../lib/getPromptPorCanal";

const router = express.Router();

// Debe ser el mismo valor que pusiste en el panel de Meta (Verify Token)
const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || "aamy-meta-verify";

const MAX_WHATSAPP_LINES = 16;

const normLang = (code?: string | null) => {
  if (!code) return null;
  const base = code.toString().split(/[-_]/)[0].toLowerCase();
  return base === "zxx" ? null : base;
};

const normalizeLang = (code?: string | null): "es" | "en" =>
  (code || "").toLowerCase().startsWith("en") ? "en" : "es";

/**
 * GET /api/meta/whatsapp/callback
 *
 * Verificación del webhook (hub.challenge)
 */
router.get("/whatsapp/callback", (req: Request, res: Response) => {
  try {
    console.log("🌐 [META WEBHOOK] GET verificación:", req.query);

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ [META WEBHOOK] Verificación OK");
      return res.status(200).send(challenge as string);
    }

    console.warn("⚠️ [META WEBHOOK] Verificación fallida", {
      mode,
      token,
      expected: VERIFY_TOKEN,
    });
    return res.sendStatus(403);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error en verificación:", err);
    return res.sendStatus(500);
  }
});

/**
 * POST /api/meta/whatsapp/callback
 *
 * Aquí llegan TODOS los eventos de mensajes de WhatsApp Cloud API.
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [META WEBHOOK] Evento recibido:",
      JSON.stringify(req.body, null, 2)
    );

    // 1️⃣ Validar estructura básica (object debe ser whatsapp_business_account)
    if (req.body?.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    const metadata = value?.metadata;

    // Puede ser solo un "status" de mensaje enviado, no un mensaje entrante
    if (!messages || !messages.length || !metadata) {
      return res.sendStatus(200);
    }

    const msg = messages[0];

    // Solo procesamos mensajes de texto por ahora
    if (msg.type !== "text" || !msg.text?.body) {
      return res.sendStatus(200);
    }

    const from = msg.from as string; // wa_id del cliente
    const body = msg.text.body as string;
    const phoneNumberId = metadata.phone_number_id as string;
    const displayNumber = metadata.display_phone_number as string | undefined;

    console.log("[META WEBHOOK] Parsed:", {
      from,
      body,
      phoneNumberId,
      displayNumber,
    });

    // 2️⃣ Buscar tenant por phone_number_id o por display_phone_number
    let tenant: any | null = null;

    try {
      const { rows } = await pool.query(
        `
        SELECT *
        FROM tenants
        WHERE whatsapp_phone_number_id = $1
           OR whatsapp_phone_number    = $2
        LIMIT 1
      `,
        [phoneNumberId, displayNumber || null]
      );
      tenant = rows[0] || null;
      console.log("[META WEBHOOK] Tenant encontrado:", tenant?.id);
    } catch (dbErr) {
      console.error("❌ [META WEBHOOK] Error buscando tenant:", dbErr);
    }

    if (!tenant) {
      console.warn(
        "[META WEBHOOK] No se encontró tenant para este número de WhatsApp.",
        { phoneNumberId, displayNumber }
      );

      await enviarRespuestaMeta({
        to: from,
        phoneNumberId,
        text:
          body && body.trim().length > 0
            ? `Hola 👋, recibí tu mensaje: "${body}". Aún no encuentro el negocio asociado a este número en Aamy.`
            : "Hola 👋, soy Aamy. Recibí tu mensaje, pero aún no encuentro el negocio asociado a este número.",
      });

      return res.sendStatus(200);
    }

    // 3️⃣ Respetar membresía activa (igual que en Twilio)
    if (!tenant.membresia_activa) {
      console.log(
        `⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se responderá.`
      );
      return res.sendStatus(200);
    }

    // 4️⃣ Detectar idioma destino (similar a Twilio)
    const tenantBase: "es" | "en" = normalizeLang(tenant?.idioma || "es");
    let idiomaDestino: "es" | "en" = tenantBase;

    try {
      const detected = await detectarIdioma(body);
      const norm = normLang(detected) || tenantBase;
      idiomaDestino = normalizeLang(norm);
    } catch {
      idiomaDestino = tenantBase;
    }

    console.log(`🌍 [META WEBHOOK] idiomaDestino = ${idiomaDestino}`);

    const promptBase = getPromptPorCanal("whatsapp", tenant, idiomaDestino);

    const CTA_TXT =
      idiomaDestino === "en"
        ? "Is there anything else I can help you with?"
        : "¿Hay algo más en lo que te pueda ayudar?";

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

    const systemPrompt = [
      promptBase,
      "",
      `Reglas:
- Usa EXCLUSIVAMENTE la información explícita en este prompt. Si algo no está, dilo sin inventar.
- Responde SIEMPRE en ${
        idiomaDestino === "en" ? "English" : "Español"
      }.
- WhatsApp: máx. ${MAX_WHATSAPP_LINES} líneas en PROSA. Sin Markdown ni bullets.
- Si el usuario hace varias preguntas, respóndelas TODAS en un solo mensaje.`,
    ].join("\n\n");

    const userPrompt = `MENSAJE_USUARIO:\n${body}\n\nResponde usando solo los datos del prompt.`;

    let respuesta = "";

    try {
      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      respuesta =
        completion.choices[0]?.message?.content?.trim() ||
        getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);

      // Registrar tokens OpenAI (igual que en Twilio)
      const used = completion.usage?.total_tokens ?? 0;
      if (used > 0) {
        await pool.query(
          `INSERT INTO uso_mensual (tenant_id, canal, mes, usados)
           VALUES ($1, 'tokens_openai', date_trunc('month', CURRENT_DATE), $2)
           ON CONFLICT (tenant_id, canal, mes)
           DO UPDATE SET usados = uso_mensual.usados + EXCLUDED.usados`,
          [tenant.id, used]
        );
      }
    } catch (e) {
      console.error("❌ [META WEBHOOK] Error llamando a OpenAI:", e);
      respuesta = getBienvenidaPorCanal("whatsapp", tenant, idiomaDestino);
    }

    // Asegurar idioma final
    try {
      const langOut = await detectarIdioma(respuesta);
      if (
        langOut &&
        langOut !== "zxx" &&
        !langOut.toLowerCase().startsWith(idiomaDestino)
      ) {
        respuesta = await traducirMensaje(respuesta, idiomaDestino);
      }
    } catch {}

    // Añadir CTA simple al final
    respuesta = `${respuesta}\n\n${CTA_TXT}`;

    console.log("[META WEBHOOK] Respuesta generada:", respuesta);

    // 5️⃣ Guardar mensaje USER + BOT (mínimo viable)
    const messageId = msg.id || null;

    try {
      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'user', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenant.id, body, "whatsapp", from || "meta", messageId]
      );

      await pool.query(
        `INSERT INTO messages (tenant_id, role, content, timestamp, canal, from_number, message_id)
         VALUES ($1, 'assistant', $2, NOW(), $3, $4, $5)
         ON CONFLICT (tenant_id, message_id) DO NOTHING`,
        [tenant.id, respuesta, "whatsapp", from || "meta", `${messageId}-bot`]
      );

      await pool.query(
        `INSERT INTO interactions (tenant_id, canal, message_id, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT DO NOTHING`,
        [tenant.id, "whatsapp", messageId]
      );
    } catch (e) {
      console.warn(
        "⚠️ [META WEBHOOK] No se pudo guardar en messages/interactions:",
        e
      );
    }

    // 6️⃣ Enviar mensaje usando WhatsApp Cloud API
    await enviarRespuestaMeta({
      to: from,
      phoneNumberId,
      text: respuesta,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    return res.sendStatus(500);
  }
});

// Función helper para enviar mensaje por Meta
async function enviarRespuestaMeta(params: {
  to: string;
  phoneNumberId: string;
  text: string;
}) {
  const { to, phoneNumberId, text } = params;

  const token = process.env.META_WA_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "❌ [META WEBHOOK] Falta META_WA_ACCESS_TOKEN para enviar mensajes."
    );
    return;
  }

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
    phoneNumberId
  )}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: text,
    },
  };

  console.log("[META WEBHOOK] Enviando respuesta a WhatsApp:", {
    url,
    payload,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const respJson = await resp.json();
  console.log(
    "📤 [META WEBHOOK] Respuesta de envío de mensaje:",
    resp.status,
    respJson
  );
}

export default router;
