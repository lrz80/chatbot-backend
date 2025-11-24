// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

/**
 * Este endpoint es el "Callback URL" configurado en Meta
 * Ejemplo público: https://api.aamy.ai/api/meta/whatsapp/callback
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    // 1) HANDSHAKE DE VERIFICACIÓN DEL WEBHOOK (hub.challenge)
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe") {
      const EXPECTED_TOKEN = process.env.META_VERIFY_TOKEN;

      if (verifyToken === EXPECTED_TOKEN) {
        console.log("✅ [WA CALLBACK] Webhook verificado correctamente.");
        // Meta espera el challenge tal cual, en texto plano
        return res.status(200).send(challenge as string);
      } else {
        console.warn(
          "⚠️ [WA CALLBACK] Verificación fallida. Token recibido:",
          verifyToken
        );
        return res.sendStatus(403);
      }
    }

    // 2) FLUJO NORMAL (SIN hub.mode): tu lógica anterior con state / tenantId
    const q = req.query as Record<string, string | undefined>;

    // tenantId viene del parámetro state que pusimos en el frontend
    const tenantId = q.state;

    if (!tenantId) {
      console.warn("[WA CALLBACK] Sin tenantId en state");
      return res
        .status(400)
        .send(
          "<h1>Error</h1><p>No se pudo identificar el negocio (falta state).</p>"
        );
    }

    // Intentamos mapear los campos típicos que podría mandar Meta
    const wabaId = q.waba_id || q.wa_waba_id || null;
    const phoneNumberId = q.phone_number_id || q.wa_phone_number_id || null;
    const phoneNumber = q.phone_number || q.wa_phone_number || null;
    const accessToken = q.access_token || q.wa_access_token || null;

    console.log("[WA CALLBACK] tenantId:", tenantId);
    console.log("[WA CALLBACK] wabaId:", wabaId);
    console.log("[WA CALLBACK] phoneNumberId:", phoneNumberId);
    console.log("[WA CALLBACK] phoneNumber:", phoneNumber);
    console.log("[WA CALLBACK] accessToken:", accessToken ? "***" : null);

    // Guarda lo que tengamos en la tabla tenants
    await pool.query(
      `
        UPDATE tenants
        SET
          whatsapp_business_id       = COALESCE($1, whatsapp_business_id),
          whatsapp_phone_number_id   = COALESCE($2, whatsapp_phone_number_id),
          whatsapp_phone_number      = COALESCE($3, whatsapp_phone_number),
          whatsapp_status            = 'connected'
        WHERE id = $4
      `,
      [wabaId, phoneNumberId, phoneNumber, tenantId]
    );

    // (Opcional) si quieres guardar también el access_token en otra tabla,
    // aquí puedes añadir el UPDATE/INSERT correspondiente.

    // HTML mínimo que cierra el popup y refresca la página de entrenamiento
    const FRONTEND_URL = "https://www.aamy.ai";

    return res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>WhatsApp conectado</title>
  </head>
  <body style="background:#050515;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
    <h1>WhatsApp conectado</h1>
    <p>Ya puedes cerrar esta ventana.</p>
    <script>
      (function() {
        var target = "${FRONTEND_URL}/dashboard/training?whatsapp=connected";
        try {
          if (window.opener && !window.opener.closed) {
            window.opener.location = target;
            window.close();
            return;
          }
        } catch (e) {
          console.error("No se pudo acceder a window.opener", e);
        }
        window.location = target;
      })();
    </script>
  </body>
</html>`);
  } catch (err) {
    console.error("❌ [WA CALLBACK] Error:", err);
    return res
      .status(500)
      .send("<h1>Error interno</h1><p>Revisa los logs del servidor.</p>");
  }
});

export default router;
