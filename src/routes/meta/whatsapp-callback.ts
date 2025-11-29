// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

/**
 * Este endpoint es el "Callback URL" configurado en:
 * - WhatsApp > Configuration (webhook)
 * - Facebook Login (Valid OAuth Redirect URIs) si lo usas
 *
 * URL pública: https://api.aamy.ai/api/meta/whatsapp/callback
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);
    const q = req.query as Record<string, string | undefined>;

    // 1) HANDSHAKE DE VERIFICACIÓN DEL WEBHOOK (hub.mode / hub.challenge)
    const mode = q["hub.mode"];
    const verifyToken = q["hub.verify_token"];
    const challenge = q["hub.challenge"];

    if (mode === "subscribe") {
      const EXPECTED_TOKEN = process.env.META_VERIFY_TOKEN;
      console.log(
        "🧩 [WA CALLBACK] Handshake webhook. Token esperado:",
        EXPECTED_TOKEN
      );
      console.log("🧩 [WA CALLBACK] Token recibido:", verifyToken);

      if (verifyToken && EXPECTED_TOKEN && verifyToken === EXPECTED_TOKEN) {
        console.log("✅ [WA CALLBACK] Webhook verificado correctamente.");
        return res.status(200).send(challenge ?? "");
      } else {
        console.warn(
          "⚠️ [WA CALLBACK] Verificación de webhook fallida. Token recibido:",
          verifyToken
        );
        return res.sendStatus(403);
      }
    }

    // 2) EMBEDDED SIGNUP (Meta-hosted) → nos envía waba_id + phone_number_id
    const tenantId = q.state;
    const waId = q.wa_id;
    const phoneNumberId = q.phone_number_id;
    const wabaId = q.waba_id;

    if (tenantId && wabaId && (waId || phoneNumberId)) {
      console.log("[WA CALLBACK] Datos de Embedded Signup:", {
        tenantId,
        waId,
        phoneNumberId,
        wabaId,
      });

      try {
        const updateQuery = `
          UPDATE tenants
          SET
            whatsapp_business_id      = $1,
            whatsapp_phone_number_id  = $2,
            whatsapp_status           = 'connected',
            whatsapp_connected        = TRUE,
            whatsapp_connected_at     = NOW(),
            updated_at                = NOW()
          WHERE id::text = $3
          RETURNING id,
                    whatsapp_business_id,
                    whatsapp_phone_number_id,
                    whatsapp_status,
                    whatsapp_connected,
                    whatsapp_connected_at;
        `;

        const result = await pool.query(updateQuery, [
          wabaId,
          phoneNumberId ?? null,
          tenantId,
        ]);

        console.log(
          "💾 [WA CALLBACK] UPDATE (embedded signup) rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        const FRONTEND_URL =
          process.env.FRONTEND_URL || "https://www.aamy.ai";

        // Página simple que intenta refrescar el dashboard y cerrar el popup
        return res.send(`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>WhatsApp conectado</title></head>
  <body style="background:#050515;color:#fff;font-family:sans-serif;text-align:center;padding-top:40px;">
    <h1>WhatsApp conectado</h1>
    <p>Tu número ha sido conectado correctamente a Aamy.</p>
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
      } catch (dbErr) {
        console.error(
          "❌ [WA CALLBACK] Error guardando datos de WhatsApp en tenants:",
          dbErr
        );
        return res
          .status(500)
          .send("<h1>Error</h1><p>No se pudo guardar la conexión en la base de datos.</p>");
      }
    }

    // 3) (OPCIONAL) CALLBACK OAUTH CON `code` + `state` SI ALGÚN DÍA LO USAS
    const code = q.code;

    if (code) {
      console.log(
        "ℹ️ [WA CALLBACK] Recibido code OAuth pero no se usa en este flujo:",
        {
          code,
          state: q.state,
        }
      );
      return res.send(
        "<h1>Code recibido</h1><p>Por ahora no se está usando el flujo OAuth.</p>"
      );
    }

    // 4) Si no es handshake, ni embedded signup, ni code → lo consideramos inválido
    console.warn(
      "⚠️ [WA CALLBACK] Sin hub.mode, sin datos de Embedded Signup ni `code`."
    );
    return res
      .status(400)
      .send(
        "<h1>Callback inválido</h1><p>No se recibieron parámetros válidos.</p>"
      );
  } catch (err) {
    console.error("❌ [WA CALLBACK] Error general:", err);
    return res
      .status(500)
      .send("<h1>Error interno</h1><p>Revisa los logs del servidor.</p>");
  }
});

export default router;
