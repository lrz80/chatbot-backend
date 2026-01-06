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

    // 1) Validación mínima
    if (req.body?.object !== "whatsapp_business_account") {
      return res.sendStatus(200);
    }

    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // 2) En modo Twilio: NO procesamos messages aquí (evita duplicación)
    if (Array.isArray(value?.messages) && value.messages.length > 0) {
      console.log("[META WEBHOOK] Ignorando messages (Twilio es el canal activo).");
      return res.sendStatus(200);
    }

    // 3) Capturar statuses (delivery/read receipts)
    const statuses = value?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      console.log(
        "📦 [META WEBHOOK] STATUSES recibido:",
        JSON.stringify(statuses, null, 2)
      );
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    return res.sendStatus(200); // importante: Meta necesita 200
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
