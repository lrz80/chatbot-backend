// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import {
  procesarMensajeWhatsApp,
  WhatsAppContext,
} from "../webhook/whatsapp"; // 👈 reutilizamos tu flujo Twilio con contexto

const router = express.Router();

// Debe ser el mismo valor que pusiste en el panel de Meta (Verify Token)
const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || "aamy-meta-verify";

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
 * Ahora solo hace de "adaptador" y delega a procesarMensajeWhatsApp.
 */
router.use((req, _res, next) => {
  console.log("🔔 [WA CALLBACK HIT]", req.method, req.originalUrl);
  next();
});

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

    // ✅ 0) Capturar statuses (delivery receipts) aunque NO haya mensajes entrantes
    const entry0 = req.body?.entry?.[0];
    const change0 = entry0?.changes?.[0];
    const value0 = change0?.value;

    const statuses = value0?.statuses;

    if (Array.isArray(statuses) && statuses.length > 0) {
      console.log("📦 [META WEBHOOK] STATUSES recibido:", JSON.stringify(statuses, null, 2));
      // Respondemos 200 rápido (no bloqueamos)
      return res.sendStatus(200);
    }

    const messages = value?.messages;
    const metadata = value?.metadata;

    if (statuses?.length) {
      console.log("📦 [META WEBHOOK] Status event:", JSON.stringify(statuses, null, 2));
      return res.sendStatus(200);
    }


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

    // Respondemos a Meta inmediatamente (como Twilio: no bloqueamos)
    res.sendStatus(200);

    // Si no hay tenant, NO respondemos nada (silencio total)
    if (!tenant) {
      console.warn(
        "[META WEBHOOK] No se encontró tenant para este número de WhatsApp. No se enviará respuesta.",
        { phoneNumberId, displayNumber }
      );
      return;
    }

    // Si el canal WhatsApp está desconectado, tampoco respondemos
    if (tenant.whatsapp_status !== "connected") {
      console.log(
        `[META WEBHOOK] WhatsApp está en estado "${tenant.whatsapp_status}" para el tenant ${tenant.name || tenant.id}. No se procesará el mensaje.`
      );
      return;
    }

    // 3️⃣ Si hay tenant pero membresía inactiva, no seguimos el flujo
    if (!tenant.membresia_activa) {
      console.log(
        `⛔ Membresía inactiva para tenant ${tenant.name || tenant.id}. No se procesará el mensaje.`
      );
      return;
    }

    // 4️⃣ Construir "body estilo Twilio" y delegar a procesarMensajeWhatsApp
    const fakeBody = {
      // El "To" para tu flujo es el número del negocio
      To: `whatsapp:${tenant.whatsapp_phone_number || displayNumber || ""}`,
      // El "From" es el número del cliente
      From: `whatsapp:${from}`,
      Body: body,
      // Usamos el ID del mensaje de Cloud como MessageSid
      MessageSid: msg.id,
    };

    // Procesar en background (igual patrón que Twilio)
    setTimeout(async () => {
      try {
        console.log(
          "[META WEBHOOK] Delegando a procesarMensajeWhatsApp con fakeBody"
        );
        await procesarMensajeWhatsApp(fakeBody, {
          tenant,          // 👈 el que ya encontraste arriba por phone_number_id
          canal: "whatsapp",
          origen: "meta",
        });
      } catch (e) {
        console.error(
          "❌ [META WEBHOOK] Error dentro de procesarMensajeWhatsApp:",
          e
        );
      }
    }, 0);

  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    // importante: si llegamos aquí antes de hacer res.status, devolvemos 500
    if (!res.headersSent) {
      return res.sendStatus(500);
    }
  }
});

// Función helper para enviar mensaje por Meta (se sigue usando solo para el caso "sin tenant")
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
