// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";

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
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [META WEBHOOK] Evento recibido:",
      JSON.stringify(req.body, null, 2)
    );

    // 1️⃣ Extraer datos básicos del mensaje
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = entry?.messages;

    if (!messages || !messages.length) {
      // Puede ser un evento de status, template, etc. Lo ignoramos.
      return res.sendStatus(200);
    }

    const msg = messages[0];

    const from = msg.from as string | undefined; // número del cliente
    const body = msg.text?.body as string | undefined;
    const phoneNumberId = entry?.metadata?.phone_number_id as string | undefined;

    console.log("[META WEBHOOK] Parsed:", { from, body, phoneNumberId });

    if (!from || !phoneNumberId) {
      console.warn(
        "[META WEBHOOK] Falta from o phoneNumberId, no se puede responder."
      );
      return res.sendStatus(200);
    }

    // 2️⃣ Preparar una respuesta sencilla (eco)
    const replyText =
      body && body.trim().length > 0
        ? `Hola 👋, recibí tu mensaje: "${body}". Muy pronto aquí responderá Aamy con toda su lógica de FAQs, flows e IA.`
        : "Hola 👋, soy Aamy. Recibí tu mensaje desde WhatsApp Cloud API.";

    // 3️⃣ Enviar mensaje usando WhatsApp Cloud API
    const token = process.env.META_WA_ACCESS_TOKEN;
    if (!token) {
      console.error(
        "❌ [META WEBHOOK] Falta META_WA_ACCESS_TOKEN para enviar mensajes."
      );
      return res.sendStatus(200);
    }

    const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
      phoneNumberId
    )}/messages`;

    const payload = {
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: {
        preview_url: false,
        body: replyText,
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

    // Siempre devolver 200 a Meta aunque el envío falle, para que no reintente.
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    return res.sendStatus(500);
  }
});

export default router;
