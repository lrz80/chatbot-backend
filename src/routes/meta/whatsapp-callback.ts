// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const router = express.Router();

const APP_ID = process.env.META_APP_ID!;
const APP_SECRET = process.env.META_APP_SECRET!;
const REDIRECT_URI = "https://api.aamy.ai/api/meta/whatsapp/callback";

// ⚠️ IMPORTANTE: esta ruta NO es el webhook de mensajes,
// es solo el callback de OAuth / conexión de número.
// DEBE SER ASÍ
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    // 1️⃣ Si algún día Meta te pega aquí un hub.challenge, podrías manejarlo;
    // por ahora asumimos que cuando viene "code" es el flujo de conexión.
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code) {
      console.warn("[WA CALLBACK] Falta parámetro code");
      return res.status(400).send("Falta parámetro code");
    }

    // 2️⃣ Recuperar tenantId desde el JWT que pusimos en `state`
    let tenantId: string | undefined;

    if (state) {
      try {
        const decoded: any = jwt.verify(
          state,
          process.env.JWT_SECRET || "aamy-secret"
        );
        tenantId =
          decoded.tenant_id || decoded.tenantId || decoded.uid || undefined;

        console.log("[WA CALLBACK] State decodificado:", {
          raw: state,
          decoded,
          tenantId,
        });
      } catch (err) {
        console.warn("[WA CALLBACK] No se pudo decodificar state JWT:", err);
      }
    }

    if (!tenantId) {
      console.error(
        "[WA CALLBACK] No se pudo determinar el tenant desde state/JWT"
      );
      return res
        .status(400)
        .send("No se pudo identificar el negocio (falta tenantId en state).");
    }

    // 3️⃣ Intercambiar code -> access_token
    const tokenUrl =
      `https://graph.facebook.com/v18.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(APP_ID)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`;

    console.log("[WA CALLBACK] URL token:", tokenUrl);

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
        .send("No se pudo obtener el access_token desde Meta.");
    }

    const accessToken = tokenJson.access_token as string;

    // 4️⃣ Consultar WABA + número con ese access_token
    const meUrl =
      "https://graph.facebook.com/v18.0/me" +
      "?fields=whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,code_verification_status}}";

    console.log("[WA CALLBACK] Llamando a /me…");

    const meResp = await fetch(`${meUrl}&access_token=${accessToken}`);
    const meJson: any = await meResp.json();

    console.log(
      "📞 [WA CALLBACK] Respuesta /me whatsapp_business_accounts:",
      meResp.status,
      JSON.stringify(meJson, null, 2)
    );

    let whatsappBusinessId: string | null = null;
    let whatsappPhoneNumberId: string | null = null;
    let whatsappPhoneNumber: string | null = null;

    const waba = meJson.whatsapp_business_accounts?.[0];
    if (waba) {
      whatsappBusinessId = waba.id ?? null;
      const phone = waba.phone_numbers?.[0];
      if (phone) {
        whatsappPhoneNumberId = phone.id ?? null;
        whatsappPhoneNumber = phone.display_phone_number ?? null;
      }
    }

    console.log("[WA CALLBACK] Datos resueltos:", {
      tenantId,
      whatsappBusinessId,
      whatsappPhoneNumberId,
      whatsappPhoneNumber,
    });

    // 5️⃣ Actualizar tenant en DB
    try {
      const updateQuery = `
        UPDATE tenants
        SET
          whatsapp_access_token     = $1,
          whatsapp_business_id      = $2,
          whatsapp_phone_number_id  = $3,
          whatsapp_phone_number     = $4,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id::text = $5
        RETURNING id,
                  whatsapp_business_id,
                  whatsapp_phone_number_id,
                  whatsapp_phone_number,
                  whatsapp_status,
                  whatsapp_connected,
                  whatsapp_connected_at;
      `;

      const result = await pool.query(updateQuery, [
        accessToken,
        whatsappBusinessId,
        whatsappPhoneNumberId,
        whatsappPhoneNumber,
        tenantId,
      ]);

      console.log(
        "💾 [WA CALLBACK] UPDATE rowCount:",
        result.rowCount,
        "rows:",
        result.rows
      );

      if (result.rowCount === 0) {
        console.warn(
          "⚠️ [WA CALLBACK] No se actualizó ningún tenant. Revisa que tenantId coincida con tenants.id"
        );
      }
    } catch (dbErr) {
      console.error(
        "❌ [WA CALLBACK] Error guardando datos de WhatsApp en tenants:",
        dbErr
      );
      return res
        .status(500)
        .send("Error al guardar los datos de WhatsApp en la base de datos.");
    }

    // 6️⃣ Página de éxito
    res.send(`
      <html>
        <head>
          <meta charset="utf-8" />
          <title>WhatsApp conectado</title>
        </head>
        <body style="font-family: system-ui; text-align: center; margin-top: 80px">
          <h1 style="font-size: 28px;">✅ WhatsApp conectado correctamente</h1>
          <p>Ya registramos tu cuenta de WhatsApp Business en Aamy.</p>
          <p>Puedes cerrar esta ventana y volver al dashboard.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ [WA CALLBACK] Error general:", err);
    return res
      .status(500)
      .send("Error interno procesando el callback de WhatsApp.");
  }
});

export default router;
