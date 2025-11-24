// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { procesarMensajeWhatsApp } from "../webhook/whatsapp";

const router = express.Router();

// FRONTEND URL
const FRONTEND_URL = "https://www.aamy.ai";
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

/**
 * GET /api/meta/whatsapp/callback
 *
 * ✓ Handshake (hub.challenge)
 * ✓ Retorno de Embedded Signup (waba_id, phone_number_id, etc.)
 * ✗ No maneja OAuth con "code" (ese es para Facebook Login, no para WhatsApp)
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    // 1️⃣ WEBHOOK VERIFICATION
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe") {
      if (verifyToken === VERIFY_TOKEN) {
        console.log("✅ Webhook verificado correctamente.");
        return res.status(200).send(challenge as string);
      }
      console.warn("⚠️ Token inválido.");
      return res.sendStatus(403);
    }

    // 2️⃣ RETORNO DE EMBEDDED SIGNUP
    const q = req.query as Record<string, string | undefined>;

    const tenantId = q.state;
    const wabaId = q.waba_id || q.wa_waba_id || null;
    const phoneNumberId = q.phone_number_id || q.wa_phone_number_id || null;
    const phoneNumber = q.phone_number || q.wa_phone_number || null;
    const accessToken = q.access_token || q.wa_persistent_token || null;

    if (!tenantId) {
      return res
        .status(400)
        .send("<h3>Error: falta state (tenantId)</h3>");
    }

    console.log("📌 Datos Embedded Signup:", {
      tenantId,
      wabaId,
      phoneNumberId,
      phoneNumber,
      accessToken: accessToken ? "***" : null,
    });

    await pool.query(
      `
      UPDATE tenants
      SET
        whatsapp_business_id      = COALESCE($1, whatsapp_business_id),
        whatsapp_phone_number_id  = COALESCE($2, whatsapp_phone_number_id),
        whatsapp_phone_number     = COALESCE($3, whatsapp_phone_number),
        whatsapp_access_token     = COALESCE($4, whatsapp_access_token),
        whatsapp_status           = 'connected'
      WHERE id = $5
    `,
      [wabaId, phoneNumberId, phoneNumber, accessToken, tenantId]
    );

    // 3️⃣ Finalizar (cerrar popup y actualizar frontend)
    return res.send(`<!doctype html>
      <html>
        <body style="background:#050515;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
          <h1>WhatsApp conectado</h1>
          <p>Ya puedes cerrar esta ventana.</p>
          <script>
            if (window.opener) {
              window.opener.location = "${FRONTEND_URL}/dashboard/training?whatsapp=connected";
              window.close();
            } else {
              window.location = "${FRONTEND_URL}/dashboard/training?whatsapp=connected";
            }
          </script>
        </body>
      </html>`);
  } catch (err) {
    console.error("❌ Error en /whatsapp/callback:", err);
    return res.status(500).send("Error interno.");
  }
});

/**
 * POST /api/meta/whatsapp/callback
 * = Webhook de mensajes reales de WhatsApp Cloud API
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("📩 [WA WEBHOOK] Payload:", JSON.stringify(req.body, null, 2));

    const body = req.body as any;
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value || value.messaging_product !== "whatsapp") {
      return res.sendStatus(200);
    }

    const msg = value.messages?.[0];
    if (!msg) return res.sendStatus(200);

    // Adaptar al formato Twilio para reutilizar lógica actual
    await procesarMensajeWhatsApp({
      To: `whatsapp:+${value.metadata.display_phone_number}`,
      From: `whatsapp:+${msg.from}`,
      Body: msg.text?.body || "",
      MessageSid: msg.id,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error procesando webhook WhatsApp:", err);
    return res.sendStatus(200);
  }
});

export default router;
