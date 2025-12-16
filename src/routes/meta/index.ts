// src/routes/meta/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";
import whatsappPhoneNumbersRouter from "../meta/whatsapp-phone-numbers";
import whatsappOnboardStartRouter from "../../routes/meta/whatsapp-onboard-start";
import whatsappAccountsRouter from "./whatsapp-accounts";
import whatsappRegister from "./whatsapp-register";
import {
  resolveBusinessIdFromWaba,
  createSystemUser,
  createSystemUserToken,
  // registerPhoneNumber, // (opcional) PIN step, no lo usamos aquí
} from "../../lib/meta/whatsappSystemUser";

const router = Router();

/**
 * POST /api/meta/whatsapp/onboard-complete
 *
 * Lo llama el frontend cuando Embedded Signup termina y devuelve:
 * - wabaId
 * - phoneNumberId
 *
 * Flujo:
 * 1) Guardar wabaId + phoneNumberId en tenants
 * 2) Tomar whatsapp_access_token del tenant (guardado en /exchange-code)
 * 3) Resolver business_manager_id dueño del WABA
 * 4) Crear system user en ese Business
 * 5) Crear system user token con scopes WA
 * 6) Guardar en tenants:
 *    whatsapp_business_manager_id, whatsapp_system_user_id, whatsapp_system_user_token
 */
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      const wabaId: string | undefined = req.body?.wabaId;
      const phoneNumberId: string | undefined =
        req.body?.phoneNumberId || req.body?.phone_number_id;

      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        wabaId,
        phoneNumberId,
        tenantId,
      });

      console.log("🧪 [WA ONBOARD COMPLETE] req.body raw:", req.body);
      console.log("🧪 [WA ONBOARD COMPLETE] req.user raw:", (req as any).user);

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }
      if (!wabaId || !phoneNumberId) {
        return res.status(400).json({
          error: "Faltan wabaId o phoneNumberId en el cuerpo",
        });
      }

      // 1) Leer token del tenant (guardado previamente en /exchange-code)
      const t = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenantToken: string | null = t.rows?.[0]?.whatsapp_access_token || null;

      console.log("🧪 [WA ONBOARD COMPLETE] tenant has whatsapp_access_token:", !!tenantToken);

      if (!tenantToken) {
        return res.status(400).json({
          error:
            "Este tenant no tiene whatsapp_access_token guardado. Primero debe ejecutarse /whatsapp/exchange-code.",
        });
      }

      // 2) Resolver Business Manager ID dueño del WABA
      const businessManagerId = await resolveBusinessIdFromWaba(wabaId, tenantToken);

      // 3) Crear System User dentro del Business del tenant
      const systemUserId = await createSystemUser({
        businessId: businessManagerId,
        userToken: tenantToken,
        name: "Aamy WhatsApp System User",
        role: "ADMIN",
      });

      // 4) Crear System User Token (scopes WA)
      const appId = process.env.META_APP_ID;
      if (!appId) {
        return res.status(500).json({ error: "Falta META_APP_ID en env." });
      }

      const systemUserToken = await createSystemUserToken({
        systemUserId,
        userToken: tenantToken,
        appId,
        scopesCsv:
          "whatsapp_business_management,whatsapp_business_messaging,business_management",
      });

      // 5) Guardar todo en DB
      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id          = $1,
          whatsapp_phone_number_id      = $2,
          whatsapp_business_manager_id  = $3,
          whatsapp_system_user_id       = $4,
          whatsapp_system_user_token    = $5,
          whatsapp_status               = 'connected',
          whatsapp_connected            = TRUE,
          whatsapp_connected_at         = NOW(),
          updated_at                    = NOW()
        WHERE id::text = $6
        RETURNING
          id,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_business_manager_id,
          whatsapp_system_user_id,
          whatsapp_system_user_token,
          whatsapp_status,
          whatsapp_connected,
          whatsapp_connected_at;
        `,
        [wabaId, phoneNumberId, businessManagerId, systemUserId, systemUserToken, tenantId]
      );

      console.log(
        "💾 [WA ONBOARD COMPLETE] UPDATE rowCount:",
        update.rowCount,
        "rows:",
        update.rows
      );

      return res.json({
        ok: true,
        tenant: update.rows?.[0],
      });
    } catch (err: any) {
      console.error("❌ [WA ONBOARD COMPLETE] Error:", err);
      return res.status(500).json({
        error: "Error interno guardando la conexión",
        detail: String(err?.message || err),
      });
    }
  }
);

/**
 * DELETE /api/meta/whatsapp/connection
 *
 * Desconecta WhatsApp para el tenant autenticado:
 * - Limpia los campos de WABA y número.
 * - Marca whatsapp_status = 'disconnected'.
 */
router.delete(
  "/whatsapp/connection",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "No autenticado: falta tenant_id en el token." });
      }

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = NULL,
          whatsapp_phone_number_id = NULL,
          whatsapp_phone_number    = NULL,
          whatsapp_access_token    = NULL,
          whatsapp_status          = 'disconnected'
        WHERE id = $1
        `,
        [tenantId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WA DISCONNECT] Error al desconectar WhatsApp:", err);
      return res
        .status(500)
        .json({ error: "Error al desconectar la cuenta de WhatsApp." });
    }
  }
);

/**
 * GET /api/meta/whatsapp/oauth-callback
 *
 * Callback de OAuth clásico de Facebook Login.
 * Aquí ya viene ?code=... en la URL, usamos la cookie del usuario
 * (authenticateUser) para saber qué tenant actualizar.
 */
router.get(
  "/whatsapp/oauth-callback",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;
      const q = req.query as Record<string, string | undefined>;
      const code = q.code;

      if (!tenantId) {
        console.error(
          "[WA OAUTH CALLBACK] Falta tenant_id en el token del usuario."
        );
        return res
          .status(401)
          .send("No se pudo identificar el negocio (falta tenantId en sesión).");
      }

      if (!code) {
        return res.status(400).send("Falta parámetro `code` en la URL.");
      }

      const APP_ID = process.env.META_APP_ID;
      const APP_SECRET = process.env.META_APP_SECRET;

      if (!APP_ID || !APP_SECRET) {
        console.error(
          "❌ [WA OAUTH CALLBACK] Falta META_APP_ID o META_APP_SECRET en env."
        );
        return res
          .status(500)
          .send("Configuración del servidor incompleta (APP_ID/SECRET).");
      }

      console.log(
        "🔁 [WA OAUTH CALLBACK] Intercambiando code por access_token...",
        { tenantId, code }
      );

      const redirectUri = "https://api.aamy.ai/api/meta/whatsapp/oauth-callback";

      const tokenUrl =
        `https://graph.facebook.com/v18.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(APP_ID)}` +
        `&client_secret=${encodeURIComponent(APP_SECRET)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&code=${encodeURIComponent(code)}`;

      console.log("[WA OAUTH CALLBACK] URL token:", tokenUrl);

      const tokenResp = await fetch(tokenUrl);
      const tokenJson: any = await tokenResp.json();

      console.log(
        "🔑 [WA OAUTH CALLBACK] Respuesta token:",
        tokenResp.status,
        tokenJson
      );

      if (!tokenResp.ok || !tokenJson.access_token) {
        console.error(
          "❌ [WA OAUTH CALLBACK] Error obteniendo access_token de Meta:",
          tokenJson
        );
        return res
          .status(500)
          .send("No se pudo obtener access_token de Meta. Revisa logs.");
      }

      const accessToken = tokenJson.access_token as string;

      // 3️⃣ Resolver automáticamente WABA + número usando el token global
      const globalToken = process.env.META_WA_ACCESS_TOKEN;
      const globalWabaId = process.env.META_WABA_ID;

      let whatsappBusinessId: string | null = null;
      let whatsappPhoneNumberId: string | null = null;
      let whatsappPhoneNumber: string | null = null;

      if (!globalToken || !globalWabaId) {
        console.warn(
          "[WA OAUTH CALLBACK] Falta META_WA_ACCESS_TOKEN o META_WABA_ID; " +
            "solo se guardará el access_token del tenant."
        );
      } else {
        const phonesUrl =
          "https://graph.facebook.com/v18.0/" +
          encodeURIComponent(globalWabaId) +
          "/phone_numbers?access_token=" +
          encodeURIComponent(globalToken);

        console.log("[WA OAUTH CALLBACK] Consultando phone_numbers:", phonesUrl);

        const phonesResp = await fetch(phonesUrl);
        const phonesJson: any = await phonesResp.json();

        console.log(
          "📞 [WA OAUTH CALLBACK] Respuesta phone_numbers:",
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
            "[WA OAUTH CALLBACK] No se pudieron obtener phone_numbers de la WABA global"
          );
        }
      }

      // 4️⃣ Actualizar tenant en DB con access_token + número
      try {
        console.log(
          "💾 [WA OAUTH CALLBACK] Actualizando tenant con datos de WhatsApp...",
          { tenantId, whatsappBusinessId, whatsappPhoneNumberId, whatsappPhoneNumber }
        );

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
          "💾 [WA OAUTH CALLBACK] UPDATE rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        if (result.rowCount === 0) {
          console.warn(
            "⚠️ [WA OAUTH CALLBACK] No se actualizó ningún tenant. " +
              "Revisa que tenantId coincida EXACTAMENTE con tenants.id"
          );
        }
      } catch (dbErr) {
        console.error(
          "❌ [WA OAUTH CALLBACK] Error guardando datos de WhatsApp en tenants:",
          dbErr
        );
        return res
          .status(500)
          .send("Error al guardar los datos de WhatsApp en DB (ver logs).");
      }

      // Página simple para el popup
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <title>WhatsApp Connected</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              text-align: center;
              margin-top: 80px;
            }
            .ok {
              color: green;
              font-size: 22px;
              margin-bottom: 20px;
            }
          </style>
        </head>
        <body>
          <div class="ok">✔ WhatsApp connected successfully</div>
          <p>Your WhatsApp Business account has been successfully registered in Aamy.</p>
          <p>This window will close automatically. You can also close it manually.</p>

          <script>
            setTimeout(() => {
              // If this window was opened as a popup:
              if (window.opener) {
                try {
                  window.opener.postMessage({ connected: true, channel: 'whatsapp' }, '*');
                } catch (e) {}
                window.close();
              } else {
                // If it was opened as a full tab, just redirect back to the dashboard
                window.location.href = 'https://www.aamy.ai/dashboard/training?connected=whatsapp';
              }
            }, 2000);
          </script>
        </body>
        </html>
      `);

    } catch (err) {
      console.error("❌ [WA OAUTH CALLBACK] Error general:", err);
      return res
        .status(500)
        .send("Error interno al procesar el callback de WhatsApp.");
    }
  }
);

/**
 * Callback / webhook WhatsApp:
 * GET /api/meta/whatsapp/callback
 * POST /api/meta/whatsapp/callback
 */
router.use("/", whatsappCallback);

/**
 * Ruta opcional de redirect para el front:
 * GET /api/meta/whatsapp-redirect
 */
router.use("/", whatsappRedirect);

// Rutas para listar/seleccionar números
router.use("/", whatsappPhoneNumbersRouter);
router.use("/whatsapp-onboard", whatsappOnboardStartRouter);
router.use("/", whatsappAccountsRouter);
router.use("/", whatsappRegister);

export default router;
