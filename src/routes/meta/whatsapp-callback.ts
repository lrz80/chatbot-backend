// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

/**
 * GET /api/meta/whatsapp/callback
 *
 * Callback de OAuth clásico (dialog/oauth).
 * Aquí:
 *   1) Recibimos ?code=...&state=tenantId
 *   2) Intercambiamos code -> access_token
 *   3) Consultamos /me?fields=whatsapp_business_accounts{phone_numbers{...}}
 *   4) Guardamos WABA + número en tenants y marcamos whatsapp_status = 'connected'
 */
router.get("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log("🟣 [WA CALLBACK] Query recibida:", req.query);

    const q = req.query as Record<string, string | undefined>;
    const code = q.code;
    const state = q.state; // debería venir el tenant_id

    // En muchos casos también tendrás req.user por cookie,
    // pero usamos state como fuente principal
    const user = (req as any).user;
    const tenantIdFromToken = user?.tenant_id as string | undefined;

    const tenantId = tenantIdFromToken || state;

    if (!code) {
      console.warn("⚠️ [WA CALLBACK] Falta parámetro code");
      return res
        .status(400)
        .send("<h1>Error</h1><p>Falta el parámetro <code>code</code>.</p>");
    }

    if (!tenantId) {
      console.warn("⚠️ [WA CALLBACK] No se pudo determinar tenantId");
      return res
        .status(400)
        .send(
          "<h1>Error</h1><p>No se pudo identificar el negocio (falta <code>state</code> o <code>tenant_id</code>).</p>"
        );
    }

    const APP_ID = process.env.META_APP_ID;
    const APP_SECRET = process.env.META_APP_SECRET;

    if (!APP_ID || !APP_SECRET) {
      console.error(
        "❌ [WA CALLBACK] Falta META_APP_ID o META_APP_SECRET en variables de entorno."
      );
      return res
        .status(500)
        .send(
          "<h1>Error servidor</h1><p>Configuración incompleta en el backend (APP_ID / SECRET).</p>"
        );
    }

    // 1️⃣ Intercambiar code -> access_token
    const REDIRECT_URI = "https://api.aamy.ai/api/meta/whatsapp/callback";

    const tokenUrl =
      `https://graph.facebook.com/v18.0/oauth/access_token` +
      `?client_id=${encodeURIComponent(APP_ID)}` +
      `&client_secret=${encodeURIComponent(APP_SECRET)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&code=${encodeURIComponent(code)}`;

    console.log("🔁 [WA CALLBACK] URL token:", tokenUrl);

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
          "<h1>Error</h1><p>No se pudo obtener el token de acceso de Meta.</p>"
        );
    }

    const accessToken = tokenJson.access_token as string;

    // 2️⃣ Consultar WABA + número
    console.log(
      "📞 [WA CALLBACK] Consultando WABA y números con /me (whatsapp_business_accounts)..."
    );

    const meUrl =
      "https://graph.facebook.com/v18.0/me" +
      "?fields=whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,code_verification_status}}";

    const meResp = await fetch(`${meUrl}&access_token=${accessToken}`);
    const meJson: any = await meResp.json();

    console.log(
      "📞 [WA CALLBACK] Respuesta /me:",
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

    // 3️⃣ Actualizar tenant en DB
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
          "⚠️ [WA CALLBACK] No se actualizó ningún tenant. Revisa que tenantId coincida EXACTAMENTE con tenants.id"
        );
      }
    } catch (dbErr) {
      console.error(
        "❌ [WA CALLBACK] Error guardando datos de WhatsApp en tenants:",
        dbErr
      );
      return res
        .status(500)
        .send(
          "<h1>Error</h1><p>No se pudieron guardar los datos de WhatsApp en la base de datos.</p>"
        );
    }

    // 4️⃣ Responder HTML simple para el popup
    return res.send(`
      <!doctype html>
      <html lang="es">
        <head>
          <meta charset="utf-8" />
          <title>WhatsApp conectado</title>
          <style>
            body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 2rem; text-align: center; }
            h1 { color: #16a34a; margin-bottom: 1rem; }
            p { margin-bottom: 0.75rem; }
          </style>
        </head>
        <body>
          <h1>✅ WhatsApp conectado correctamente</h1>
          <p>Ya registramos tu cuenta de WhatsApp Business en Aamy.</p>
          <p>Puedes cerrar esta ventana y volver al dashboard.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ [WA CALLBACK] Error general:", err);
    return res
      .status(500)
      .send(
        "<h1>Error</h1><p>Ocurrió un error interno al procesar la conexión de WhatsApp.</p>"
      );
  }
});

export default router;
