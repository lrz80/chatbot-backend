// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

// URL del frontend
const FRONTEND_URL = "https://www.aamy.ai";

// Debe coincidir con lo configurado en Meta → Verify Token
const VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;

// Usado para intercambio de `code` (OAuth estándar, si lo necesitas)
const META_APP_ID = process.env.META_APP_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
// Debe coincidir EXACTAMENTE con lo configurado en Meta para el OAuth
const OAUTH_REDIRECT_URI =
  "https://api.aamy.ai/api/meta/whatsapp/callback";

/**
 * GET /api/meta/whatsapp/callback
 *
 * Maneja tres casos:
 *  1) Verificación del webhook (hub.mode / hub.verify_token / hub.challenge)
 *  2) Flujo OAuth estándar con `code` + `state` (si lo usas)
 *  3) Flujo Embedded Signup que devuelve waba_id, phone_number_id, etc. en query
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    // 1️⃣ HANDSHAKE DE VERIFICACIÓN DEL WEBHOOK (hub.challenge)
    const mode = req.query["hub.mode"];
    const verifyToken = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe") {
      if (!VERIFY_TOKEN) {
        console.error(
          "❌ [WA CALLBACK] Falta META_VERIFY_TOKEN en variables de entorno"
        );
        return res.sendStatus(500);
      }

      if (verifyToken === VERIFY_TOKEN) {
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

    // 2️⃣ FLUJO OAUTH ESTÁNDAR (si Meta redirige con `code` + `state`)
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (code && state && !req.query.waba_id) {
      console.log("🔄 [WA CALLBACK] Flujo OAuth con code + state");

      if (!META_APP_ID || !META_APP_SECRET) {
        console.error(
          "❌ [WA CALLBACK] Faltan META_APP_ID o META_APP_SECRET en env"
        );
        return res
          .status(500)
          .send(
            "<h1>Error de configuración</h1><p>Faltan credenciales de Meta en el backend.</p>"
          );
      }

      try {
        // Intercambiamos el `code` por un access_token de Meta
        const tokenUrl = new URL(
          "https://graph.facebook.com/v18.0/oauth/access_token"
        );
        tokenUrl.searchParams.set("client_id", META_APP_ID);
        tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
        tokenUrl.searchParams.set("redirect_uri", OAUTH_REDIRECT_URI);
        tokenUrl.searchParams.set("code", code);

        console.log("🌍 [WA CALLBACK] Solicitando access_token a:", tokenUrl.toString());

        const tokenRes = await fetch(tokenUrl.toString(), {
          method: "GET",
        });

        if (!tokenRes.ok) {
          const text = await tokenRes.text();
          console.error(
            "❌ [WA CALLBACK] Error al obtener access_token desde Meta:",
            tokenRes.status,
            text
          );
          return res
            .status(500)
            .send(
              "<h1>Error al conectar con Meta</h1><p>No se pudo obtener el access_token.</p>"
            );
        }

        const tokenJson = (await tokenRes.json()) as {
          access_token: string;
          token_type?: string;
          expires_in?: number;
        };

        const accessToken = tokenJson.access_token;
        console.log("🔑 [WA CALLBACK] access_token obtenido OK (no se loguea el valor completo)");

        // Aquí podrías hacer más llamadas a la Graph API para:
        // - Obtener el WABA ID
        // - Obtener phone_number_id y display_phone_number
        //
        // Por simplicidad, en este paso guardamos solo el access_token
        // asociado al tenant (state = tenant_id).

        const tenantId = state;

        await pool.query(
          `
          UPDATE tenants
          SET
            whatsapp_access_token = $1,
            whatsapp_status        = 'connected'
          WHERE id = $2
        `,
          [accessToken, tenantId]
        );

        console.log(
          "💾 [WA CALLBACK] access_token guardado para tenant:",
          tenantId
        );

        // HTML mínimo que cierra el popup y refresca el dashboard
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
        console.error("❌ [WA CALLBACK] Error en flujo OAuth:", err);
        return res
          .status(500)
          .send(
            "<h1>Error interno</h1><p>No se pudo completar la conexión con WhatsApp.</p>"
          );
      }
    }

    // 3️⃣ FLUJO EMBEDDED SIGNUP (Meta devuelve waba_id, phone_number_id, etc. en query)
    const q = req.query as Record<string, string | undefined>;

    const tenantIdFromState = q.state;

    if (!tenantIdFromState) {
      console.warn("[WA CALLBACK] Sin tenantId en state en flujo normal");
      return res
        .status(400)
        .send(
          "<h1>Error</h1><p>No se pudo identificar el negocio (falta state).</p>"
        );
    }

    // Campos típicos del retorno de WhatsApp Embedded Signup
    const wabaId = q.waba_id || q.wa_waba_id || null;
    const phoneNumberId = q.phone_number_id || q.wa_phone_number_id || null;
    const phoneNumber = q.phone_number || q.wa_phone_number || null;
    const accessTokenEmbedded =
      q.access_token || q.wa_access_token || q.wa_persistent_token || null;

    console.log("[WA CALLBACK] tenantId (state):", tenantIdFromState);
    console.log("[WA CALLBACK] wabaId:", wabaId);
    console.log("[WA CALLBACK] phoneNumberId:", phoneNumberId);
    console.log("[WA CALLBACK] phoneNumber:", phoneNumber);
    console.log(
      "[WA CALLBACK] accessTokenEmbedded:",
      accessTokenEmbedded ? "***" : null
    );

    // Guardamos todo lo que tengamos en la tabla tenants
    await pool.query(
      `
        UPDATE tenants
        SET
          whatsapp_business_id       = COALESCE($1, whatsapp_business_id),
          whatsapp_phone_number_id   = COALESCE($2, whatsapp_phone_number_id),
          whatsapp_phone_number      = COALESCE($3, whatsapp_phone_number),
          whatsapp_access_token      = COALESCE($4, whatsapp_access_token),
          whatsapp_status            = 'connected'
        WHERE id = $5
      `,
      [wabaId, phoneNumberId, phoneNumber, accessTokenEmbedded, tenantIdFromState]
    );

    console.log("💾 [WA CALLBACK] Datos de WhatsApp guardados correctamente.");

    // HTML mínimo que cierra el popup y refresca la página de entrenamiento
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
    console.error("❌ [WA CALLBACK] Error general en GET:", err);
    return res
      .status(500)
      .send("<h1>Error interno</h1><p>Revisa los logs del servidor.</p>");
  }
});

/**
 * POST /api/meta/whatsapp/callback
 *
 * Aquí llegarán los mensajes reales de WhatsApp desde Meta.
 * De momento solo los logueamos y respondemos 200.
 * Luego conectaremos esto a tu lógica actual de WhatsApp (OpenAI, FAQs, flows, etc.).
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [WA WEBHOOK] Evento entrante desde Meta:",
      JSON.stringify(req.body, null, 2)
    );

    // TODO:
    //  - Detectar de qué tenant es el mensaje (por phone_number_id / WABA ID)
    //  - Reutilizar tu lógica de whatsapp.ts (intents, FAQs, flows, OpenAI)
    //  - Guardar en messages, interactions, sales_intelligence, etc.
    //  - Enviar respuesta a través de la API de WhatsApp Cloud

    // Meta exige SIEMPRE 200 para confirmar recepción.
    res.sendStatus(200);
  } catch (err) {
    console.error("❌ [WA WEBHOOK] Error procesando evento POST:", err);
    // Incluso si hay error, respondemos 200 para evitar reintentos infinitos
    res.sendStatus(200);
  }
});

export default router;
