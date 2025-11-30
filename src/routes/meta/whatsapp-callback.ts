// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import jwt from "jsonwebtoken";
import pool from "../../lib/db";

const router = express.Router();

const APP_ID = process.env.META_APP_ID!;
const APP_SECRET = process.env.META_APP_SECRET!;
const REDIRECT_URI = "https://api.aamy.ai/api/meta/whatsapp/callback";

router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🌐 [WA CALLBACK] Query recibida:", req.query);

    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code) {
      console.warn("[WA CALLBACK] Falta parámetro code");
      return res.status(400).send("Falta parámetro code");
    }

    // 1️⃣ Recuperar tenantId desde el JWT que pusimos en `state`
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

    // 2️⃣ Intercambiar code -> access_token (token propio del tenant)
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

    // 3️⃣ Resolver automáticamente la WABA y el número usando el WABA global
    let whatsappBusinessId: string | null = null;
    let whatsappPhoneNumberId: string | null = null;
    let whatsappPhoneNumber: string | null = null;

    const globalToken = process.env.META_WA_ACCESS_TOKEN;
    const globalWabaId = process.env.META_WABA_ID;

    if (!globalToken || !globalWabaId) {
      console.warn(
        "[WA CALLBACK] Falta META_WA_ACCESS_TOKEN o META_WABA_ID; " +
          "solo se guardará el access_token del tenant."
      );
    } else {
      const phonesUrl =
        "https://graph.facebook.com/v18.0/" +
        encodeURIComponent(globalWabaId) +
        "/phone_numbers?access_token=" +
        encodeURIComponent(globalToken);

      console.log("[WA CALLBACK] Consultando phone_numbers:", phonesUrl);

      const phonesResp = await fetch(phonesUrl);
      const phonesJson: any = await phonesResp.json();

      console.log(
        "📞 [WA CALLBACK] Respuesta phone_numbers:",
        phonesResp.status,
        JSON.stringify(phonesJson, null, 2)
      );

      if (phonesResp.ok && Array.isArray(phonesJson.data) && phonesJson.data.length > 0) {
        const phone = phonesJson.data[0];

        whatsappBusinessId = globalWabaId;
        whatsappPhoneNumberId = phone.id ?? null;
        whatsappPhoneNumber = phone.display_phone_number ?? null;
      } else {
        console.warn(
          "[WA CALLBACK] No se pudieron obtener phone_numbers de la WABA global"
        );
      }
    }

    console.log("[WA CALLBACK] Datos resueltos:", {
      tenantId,
      whatsappBusinessId,
      whatsappPhoneNumberId,
      whatsappPhoneNumber,
    });

    // 4️⃣ Actualizar tenant en DB (access_token + WABA + número)
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

    // 5️⃣ Página de éxito
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
