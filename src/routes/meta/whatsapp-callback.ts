// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { procesarMensajeWhatsApp } from "../webhook/whatsapp"; // 👈 motor central

const router = express.Router();

const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || "aamy-meta-verify";

/**
 * GET /api/meta/whatsapp/callback
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
 * Adaptamos el payload y delegamos a procesarMensajeWhatsApp,
 * luego enviamos la respuesta por Graph API.
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [META WEBHOOK] Evento recibido:",
      JSON.stringify(req.body, null, 2)
    );

    // 1️⃣ Validar estructura básica
    if (req.body?.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const messages = value?.messages;
    const metadata = value?.metadata;

    // Puede ser solo un "status", sin mensaje entrante
    if (!messages || !messages.length || !metadata) {
      return res.sendStatus(200);
    }

    const msg = messages[0];

    // Solo procesamos texto por ahora
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

    // ✅ Respondemos a Meta lo más rápido posible
    res.sendStatus(200);

    // 3️⃣ Caso sin tenant: respuesta simple y salimos (no se registra en DB)
    if (!tenant) {
      console.warn(
        "[META WEBHOOK] No se encontró tenant para este número de WhatsApp.",
        { phoneNumberId, displayNumber }
      );

      try {
        await enviarRespuestaMeta({
          to: from,
          phoneNumberId,
          text:
            body && body.trim().length > 0
              ? `Hola 👋, recibí tu mensaje: "${body}". Aún no encuentro el negocio asociado a este número en Aamy.`
              : "Hola 👋, soy Aamy. Recibí tu mensaje, pero aún no encuentro el negocio asociado a este número.",
        });
      } catch (e) {
        console.error(
          "❌ [META WEBHOOK] Error enviando respuesta genérica sin tenant:",
          e
        );
      }

      return;
    }

    // 4️⃣ Membresía inactiva: no seguimos el flujo
    if (!tenant.membresia_activa) {
      console.log(
        `⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se procesará el mensaje.`
      );
      return;
    }

    // 5️⃣ Construir "body estilo Twilio" para el motor central
    const fakeBody = {
      To: `whatsapp:${tenant.whatsapp_phone_number || displayNumber || ""}`, // número del negocio (Cloud)
      From: `whatsapp:${from}`, // número del cliente
      Body: body,
      MessageSid: msg.id,
    };

    try {
      console.log(
        "[META WEBHOOK] Delegando a procesarMensajeWhatsApp con fakeBody"
      );

      // Solo delegamos la lógica al motor central.
      // procesarMensajeWhatsApp sigue enviando la respuesta como siempre.
      await procesarMensajeWhatsApp(fakeBody, {
        tenant,
        canal: "whatsapp", // mismo nombre que usas en messages/interactions
        origen: "meta",    // opcional, por si luego quieres diferenciar
      });
    } catch (e) {
      console.error(
        "❌ [META WEBHOOK] Error dentro de procesarMensajeWhatsApp:",
        e
      );
    }

      } catch (err) {
        console.error("❌ [META WEBHOOK] Error procesando evento:", err);
        if (!res.headersSent) {
          return res.sendStatus(500);
        }
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
