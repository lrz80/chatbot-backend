// src/routes/meta/whatsapp-callback.ts

import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

// Usa el mismo token que pusiste en el panel de Meta:
// aamy_webhook_verify_2025  -> ponlo en el .env
const META_WHATSAPP_VERIFY_TOKEN =
  process.env.META_WHATSAPP_VERIFY_TOKEN || "aamy_webhook_verify_2025";

/**
 * GET  /api/meta-webhook
 * Handshake de verificación del webhook de WhatsApp (Meta).
 * Meta enviará: hub.mode, hub.verify_token, hub.challenge
 */
router.get("/api/meta-webhook", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("🔎 GET /api/meta-webhook verify", { mode, token, challenge });

  if (mode === "subscribe" && token === META_WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ Webhook de WhatsApp verificado correctamente");
    return res.status(200).send(challenge);
  }

  console.warn("❌ Verificación de webhook fallida");
  return res.sendStatus(403);
});

/**
 * POST /api/meta-webhook
 * Aquí llega:
 *  - El tráfico normal del webhook de WhatsApp (mensajes, estados)
 *  - Y la info de sesión de Embedded Signup (WABA, número, etc.) si la apuntas a esta URL
 */
router.post("/api/meta-webhook", async (req: Request, res: Response) => {
  console.log('📩 META WEBHOOK RAW BODY:', JSON.stringify(req.body, null, 2));
  try {
    const body = req.body as any;
    console.log("📩 POST /api/meta-webhook BODY:", JSON.stringify(body, null, 2));

    // 1) Intentar leer el "state" que mandamos desde el dashboard (tenant_id)
    const rawState: string | undefined =
      body.state ||
      body.client_state ||
      body.clientState ||
      body?.data?.state;

    const tenantId = rawState || null;

    // 2) Intentar extraer info de WhatsApp Business / número
    //    (Meta puede mandar diferentes formatos, por eso tantos "||")
    const whatsappBusinessId =
      body.whatsapp_business_account_id ||
      body.waba_id ||
      body.whatsapp_business_account?.id ||
      null;

    const phoneNumberId =
      body.phone_number_id ||
      body.phone_number?.id ||
      body.phone?.id ||
      null;

    const displayPhoneNumber =
      body.display_phone_number ||
      body.phone_number ||
      body.phone_number?.display_phone_number ||
      body.phone?.display_phone_number ||
      null;

    console.log("🔍 Parsed signup info:", {
      tenantId,
      whatsappBusinessId,
      phoneNumberId,
      displayPhoneNumber,
    });

    // 3) Si tenemos tenantId y al menos algún dato útil, actualizamos el tenant
    if (tenantId && (whatsappBusinessId || phoneNumberId || displayPhoneNumber)) {
      await pool.query(
        `UPDATE tenants
         SET
           whatsapp_business_id      = COALESCE($1, whatsapp_business_id),
           whatsapp_phone_number     = COALESCE($2, whatsapp_phone_number),
           whatsapp_phone_number_id  = COALESCE($3, whatsapp_phone_number_id),
           whatsapp_mode             = 'meta',
           whatsapp_status           = 'connected',
           whatsapp_connected        = true,
           whatsapp_connected_at     = NOW()
         WHERE id = $4`,
        [whatsappBusinessId, displayPhoneNumber, phoneNumberId, tenantId]
      );

      console.log("✅ Tenant actualizado con datos de WhatsApp (Meta):", tenantId);
    } else {
      console.log(
        "ℹ️ No se actualizó tenant: faltan tenantId o datos de WhatsApp en el payload"
      );
    }

    // 4) Responder 200 SIEMPRE para que Meta no repita el evento
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("❌ Error en POST /api/meta-webhook:", err);
    // Aun así respondemos 200 para que Meta no marque error permanente
    return res.status(200).json({ received: true });
  }
});

export default router;
