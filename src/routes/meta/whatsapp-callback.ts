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
 * 2) CALLBACK OAUTH (GET con code + state) desde el login de Meta
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    // 1) HANDSHAKE DE VERIFICACIÓN DEL WEBHOOK
    const mode = req.query["hub.mode"] as string | undefined;
    const verifyToken = req.query["hub.verify_token"] as string | undefined;
    const challenge = req.query["hub.challenge"] as string | undefined;

    if (mode === "subscribe") {
      const EXPECTED_TOKEN = process.env.META_VERIFY_TOKEN;
      console.log("🧩 [WA CALLBACK] Handshake webhook. Token esperado:", EXPECTED_TOKEN);
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

    // 2) CALLBACK OAUTH (code + state)
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined; // tenantId

    if (!code) {
      console.warn("⚠️ [WA CALLBACK] Sin hub.mode ni code en query.");
      return res
        .status(400)
        .send("<h1>Callback inválido</h1><p>No se recibió code ni hub.challenge.</p>");
    }

    if (!state) {
      console.warn("⚠️ [WA CALLBACK] Falta parámetro state (tenantId) en callback OAuth.");
      return res
        .status(400)
        .send("<h1>Error</h1><p>No se pudo identificar el negocio (falta state).</p>");
    }

    const tenantId = state;
    console.log("🏢 [WA CALLBACK] tenantId desde state:", tenantId);

    const APP_ID = process.env.META_APP_ID;
    const APP_SECRET = process.env.META_APP_SECRET;
    const BACKEND_PUBLIC_URL =
      process.env.BACKEND_PUBLIC_URL || "https://api.aamy.ai";

    if (!APP_ID || !APP_SECRET) {
      console.error(
        "❌ [WA CALLBACK] Falta META_APP_ID o META_APP_SECRET en variables de entorno."
      );
      return res
        .status(500)
        .send("<h1>Error</h1><p>Configuración del servidor incompleta (APP_ID/SECRET).</p>");
    }

    const redirectUri = `${BACKEND_PUBLIC_URL}/api/meta/whatsapp/callback`;
    console.log("🔁 [WA CALLBACK] Intercambiando code por access_token en Graph...");
    console.log("🔁 redirect_uri usado:", redirectUri);

    const tokenUrl =
      `https://graph.facebook.com/v18.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(APP_ID)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&code=${encodeURIComponent(code)}`;

    const tokenResp = await fetch(tokenUrl);
    const tokenJson: any = await tokenResp.json();

    console.log("🔑 [WA CALLBACK] Respuesta token:", tokenJson);

    if (!tokenResp.ok || !tokenJson.access_token) {
      console.error(
        "❌ [WA CALLBACK] Error obteniendo access_token de Meta:",
        tokenJson
      );
      return res
        .status(500)
        .send("<h1>Error</h1><p>No se pudo obtener access_token de Meta.</p>");
    }

    const accessToken = tokenJson.access_token as string;

    // 2.1 Intentar detectar la WABA (whatsapp_business_account) asociada a este login
    let wabaId: string | null = null;
    const candidateWabas = new Set<string>();

    // 2.1.a Intento 1: /me/whatsapp_business_accounts
    try {
      const wabaResp = await fetch(
        `https://graph.facebook.com/v18.0/me/whatsapp_business_accounts?access_token=${encodeURIComponent(
          accessToken
        )}`
      );
      const wabaJson: any = await wabaResp.json();
      console.log(
        "[WA CALLBACK] /me/whatsapp_business_accounts:",
        JSON.stringify(wabaJson, null, 2)
      );

      if (Array.isArray(wabaJson?.data)) {
        for (const w of wabaJson.data) {
          if (w?.id) candidateWabas.add(String(w.id));
        }
      }
    } catch (wErr) {
      console.error(
        "⚠️ [WA CALLBACK] Error en /me/whatsapp_business_accounts:",
        wErr
      );
    }

    // 2.1.b Intento 2: /me/businesses -> owned_whatsapp_business_accounts
    if (candidateWabas.size === 0) {
      try {
        const bizResp = await fetch(
          `https://graph.facebook.com/v18.0/me/businesses?access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const bizJson: any = await bizResp.json();
        console.log(
          "[WA CALLBACK] /me/businesses:",
          JSON.stringify(bizJson, null, 2)
        );

        const businesses: any[] = Array.isArray(bizJson?.data)
          ? bizJson.data
          : [];

        for (const biz of businesses) {
          const bizId = String(biz.id);
          try {
            const ownedResp = await fetch(
              `https://graph.facebook.com/v18.0/${encodeURIComponent(
                bizId
              )}/owned_whatsapp_business_accounts?access_token=${encodeURIComponent(
                accessToken
              )}`
            );
            const ownedJson: any = await ownedResp.json();
            console.log(
              `[WA CALLBACK] owned_whatsapp_business_accounts (biz ${bizId}):`,
              JSON.stringify(ownedJson, null, 2)
            );

            const ownedWabas: any[] = Array.isArray(ownedJson?.data)
              ? ownedJson.data
              : [];

            for (const w of ownedWabas) {
              if (w?.id) candidateWabas.add(String(w.id));
            }
          } catch (owErr) {
            console.warn(
              `[WA CALLBACK] Error consultando owned_whatsapp_business_accounts de biz ${bizId}:`,
              owErr
            );
          }
        }
      } catch (bizErr) {
        console.error("⚠️ [WA CALLBACK] Error en /me/businesses:", bizErr);
      }
    }

    if (candidateWabas.size === 1) {
      wabaId = Array.from(candidateWabas)[0];
      console.log("✅ [WA CALLBACK] WABA detectada para este tenant:", wabaId);
    } else if (candidateWabas.size > 1) {
      console.warn(
        "[WA CALLBACK] Se detectaron varias WABAs para este login, no se asigna automáticamente:",
        Array.from(candidateWabas)
      );
    } else {
      console.warn(
        "[WA CALLBACK] No se encontró ninguna WABA asociada a este login."
      );
    }

    // 2.2 Guardar access_token + (opcionalmente) WABA ID + estado conectado
    try {
      const updateQuery = `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          whatsapp_business_id  = COALESCE($2, whatsapp_business_id),
          whatsapp_status       = 'connected',
          updated_at            = NOW()
        WHERE id::text = $3
        RETURNING id, whatsapp_status, whatsapp_business_id;
      `;

      const result = await pool.query(updateQuery, [accessToken, wabaId, tenantId]);
      console.log("💾 [WA CALLBACK] Tenant actualizado:", result.rows[0]);
    } catch (dbErr) {
      console.error("❌ [WA CALLBACK] Error guardando datos en tenants:", dbErr);
    }

    const FRONTEND_URL = process.env.FRONTEND_URL || "https://www.aamy.ai";

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
    console.error("❌ [WA CALLBACK] Error general:", err);
    return res
      .status(500)
      .send("<h1>Error interno</h1><p>Revisa los logs del servidor.</p>");
  }
});

// 📩 POST /whatsapp/callback (webhook de mensajes)
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [WA WEBHOOK] Evento entrante desde Meta:",
      JSON.stringify(req.body, null, 2)
    );

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
