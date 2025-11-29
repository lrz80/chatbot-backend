// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { procesarMensajeWhatsApp } from "../webhook/whatsapp";

const router = express.Router();

/**
 * Endpoint de Callback / Webhook para WhatsApp en Meta
 *
 * URL pública: https://api.aamy.ai/api/meta/whatsapp/callback
 *
 * 1) VERIFICACIÓN DE WEBHOOK (GET con hub.mode / hub.challenge)
 * 2) CALLBACK DE EMBEDDED SIGNUP (GET con state + wa_id / phone_number_id / waba_id)
 * 3) CALLBACK OAUTH (GET con code + state) desde Embedded Signup
 * 4) WEBHOOK DE MENSAJES (POST)
 */

// 👉 GET: verificación de webhook + embedded signup + callback OAuth
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);
    const q = req.query as Record<string, string | undefined>;

    // 1) HANDSHAKE DE VERIFICACIÓN DEL WEBHOOK
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

        // 2) CALLBACK DE EMBEDDED SIGNUP CON wa_id / phone_number_id / waba_id
    const waId = q.wa_id ?? null;
    const phoneNumberId = q.phone_number_id ?? null;
    const wabaId = q.waba_id ?? null;

    if (waId || phoneNumberId || wabaId) {
      const tenantId = q.state;

      if (!tenantId) {
        console.warn("[WA CALLBACK] Falta parámetro state (tenantId).");
        return res
          .status(400)
          .send(
            "<h1>Error</h1><p>No se pudo identificar el negocio (falta state).</p>"
          );
      }

      console.log("[WA CALLBACK] Datos de Embedded Signup:", {
        tenantId,
        waId,
        phoneNumberId,
        wabaId,
      });

      try {
        // 👇 Aquí adaptamos a tus columnas reales de la tabla tenants
        const updateQuery = `
          UPDATE tenants
          SET
            whatsapp_business_id      = $1,  -- WABA ID
            whatsapp_phone_number_id  = $2,  -- phone_number_id de Meta
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
          phoneNumberId,
          tenantId,
        ]);

        console.log(
          "💾 [WA CALLBACK] UPDATE (embedded signup) rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        if (result.rowCount === 0) {
          console.warn(
            "⚠️ [WA CALLBACK] No se actualizó ningún tenant (embedded signup). " +
              "Revisa que state (tenantId) coincida EXACTAMENTE con tenants.id"
          );
        }
      } catch (dbErr) {
        console.error(
          "❌ [WA CALLBACK] Error guardando datos de WhatsApp en tenants:",
          dbErr
        );
      }

      const FRONTEND_URL =
        process.env.FRONTEND_URL || "https://www.aamy.ai";

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
    }

    // 3) CALLBACK OAUTH CODE + STATE (tu lógica actual)
    const code = q.code;
    const state = q.state; // tenantId

    if (code) {
      if (!state) {
        console.warn(
          "⚠️ [WA CALLBACK] Falta parámetro state (tenantId) en callback OAuth."
        );
        return res
          .status(400)
          .send(
            "<h1>Error</h1><p>No se pudo identificar el negocio (falta state).</p>"
          );
      }

      const tenantId = state;
      console.log("🏢 [WA CALLBACK] tenantId desde state:", tenantId);

      const APP_ID = process.env.META_APP_ID;
      const APP_SECRET = process.env.META_APP_SECRET;

      if (!APP_ID || !APP_SECRET) {
        console.error(
          "❌ [WA CALLBACK] Falta META_APP_ID o META_APP_SECRET en variables de entorno."
        );
        return res
          .status(500)
          .send(
            "<h1>Error</h1><p>Configuración del servidor incompleta (APP_ID/SECRET).</p>"
          );
      }

      console.log(
        "🔁 [WA CALLBACK] Intercambiando code por access_token en Graph..."
      );

      // Si en tu flujo de onboarding usas redirect_uri, aquí debe ser EL MISMO
      // const REDIRECT_URI = "https://api.aamy.ai/api/meta/whatsapp/callback";

      const tokenUrl =
        `https://graph.facebook.com/v18.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(APP_ID)}` +
        `&client_secret=${encodeURIComponent(APP_SECRET)}` +
        `&code=${encodeURIComponent(code)}`;
      // + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // descomenta si usas redirect_uri en el onboarding

      console.log("🔁 [WA CALLBACK] URL intercambio code->token:", tokenUrl);

      const tokenResp = await fetch(tokenUrl);
      const tokenJson: any = await tokenResp.json();

      console.log(
        "🔑 [WA CALLBACK] Respuesta token:",
        tokenResp.status,
        tokenJson
      );

      if (!tokenResp.ok || !tokenJson.access_token) {
        console.error(
          "❌ [WA CALLBACK] Error obteniendo access_token de Meta:",
          tokenJson
        );
        return res
          .status(500)
          .send(
            "<h1>Error</h1><p>No se pudo obtener access_token de Meta.</p>"
          );
      }

      const accessToken = tokenJson.access_token as string;

      try {
        console.log(
          "💾 [WA CALLBACK] Intentando actualizar tenant con access_token..."
        );
        console.log("💾 [WA CALLBACK] tenantId (state):", tenantId);

        const updateQuery = `
          UPDATE tenants
          SET
            whatsapp_access_token = $1,
            whatsapp_status       = 'connected',
            updated_at            = NOW()
          WHERE id::text = $2
          RETURNING id, whatsapp_status;
        `;

        const result = await pool.query(updateQuery, [accessToken, tenantId]);

        console.log(
          "💾 [WA CALLBACK] UPDATE rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        if (result.rowCount === 0) {
          console.warn(
            "⚠️ [WA CALLBACK] No se actualizó ningún tenant. " +
              "Revisa que state (tenantId) coincida EXACTAMENTE con tenants.id"
          );
        }
      } catch (dbErr) {
        console.error(
          "❌ [WA CALLBACK] Error guardando access_token en tenants:",
          dbErr
        );
      }

      const FRONTEND_URL =
        process.env.FRONTEND_URL || "https://www.aamy.ai";

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
    }

    // 4) Si no es ni webhook, ni wa_id, ni code → error genérico
    console.warn("[WA CALLBACK] Query no reconocida:", q);
    return res
      .status(400)
      .send(
        "<h1>Callback inválido</h1><p>Parámetros insuficientes o no reconocidos.</p>"
      );
  } catch (err) {
    console.error("❌ [WA CALLBACK] Error general:", err);
    return res
      .status(500)
      .send(
        "<h1>Error interno</h1><p>Revisa los logs del servidor.</p>"
      );
  }
});

// 📩 POST /whatsapp/callback (webhook de mensajes)
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [WA WEBHOOK] Evento entrante desde Meta:",
      JSON.stringify(req.body, null, 2)
    );

    // Meta necesita 200 rápido
    res.sendStatus(200);

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (!value?.messages) return;

    for (const msg of value.messages) {
      const fromNumber = msg.from;
      const toNumber = value?.metadata?.display_phone_number;
      const textBody = msg.text?.body || "";
      const messageId = msg.id;

      const fakeTwilioBody = {
        To: `whatsapp:${toNumber}`,
        From: `whatsapp:${fromNumber}`,
        Body: textBody,
        MessageSid: messageId,
      };

      await procesarMensajeWhatsApp(fakeTwilioBody);
    }
  } catch (err) {
    console.error("❌ [WA WEBHOOK] Error manejando mensaje entrante:", err);
    return res.sendStatus(500);
  }
});

export default router;
