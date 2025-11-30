// src/routes/meta/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";
import whatsappPhoneNumbersRouter from "../meta/whatsapp-phone-numbers";
import whatsappOnboardStartRouter from "../../routes/meta/whatsapp-onboard-start";

const router = Router();

/**
 * POST /api/meta/whatsapp/exchange-code
 *
 * El frontend nos envía el `code` devuelto por Embedded Signup.
 * Aquí lo intercambiamos por access_token y lo guardamos en tenants.
 */
router.post(
  "/whatsapp/exchange-code",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId =
        user?.tenant_id || (req as any).user?.tenantId;

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "No autenticado: falta tenant_id en el token." });
      }

      const { code } = req.body as { code?: string };

      if (!code) {
        return res.status(400).json({ error: "Falta `code` en el body." });
      }

      const APP_ID = process.env.META_APP_ID;
      const APP_SECRET = process.env.META_APP_SECRET;

      if (!APP_ID || !APP_SECRET) {
        console.error(
          "❌ [WA EXCHANGE CODE] Falta META_APP_ID o META_APP_SECRET en env."
        );
        return res.status(500).json({
          error: "Configuración del servidor incompleta (APP_ID/SECRET).",
        });
      }

      console.log(
        "🔁 [WA EXCHANGE CODE] Intercambiando code por access_token...",
        { tenantId, code }
      );

      const tokenUrl =
        `https://graph.facebook.com/v18.0/oauth/access_token` +
        `?client_id=${encodeURIComponent(APP_ID)}` +
        `&client_secret=${encodeURIComponent(APP_SECRET)}` +
        `&code=${encodeURIComponent(code)}`;

      console.log("🔁 [WA EXCHANGE CODE] URL:", tokenUrl);

      const tokenResp = await fetch(tokenUrl);
      const tokenJson: any = await tokenResp.json();

      console.log(
        "🔑 [WA EXCHANGE CODE] Respuesta token:",
        tokenResp.status,
        tokenJson
      );

      if (!tokenResp.ok || !tokenJson.access_token) {
        console.error(
          "❌ [WA EXCHANGE CODE] Error obteniendo access_token de Meta:",
          tokenJson
        );
        return res.status(500).json({
          error: "No se pudo obtener access_token de Meta.",
          detail: tokenJson,
        });
      }

      const accessToken = tokenJson.access_token as string;

      try {
        console.log(
          "💾 [WA EXCHANGE CODE] Actualizando tenant con access_token...",
          tenantId
        );

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
          "💾 [WA EXCHANGE CODE] UPDATE rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        if (result.rowCount === 0) {
          console.warn(
            "⚠️ [WA EXCHANGE CODE] No se actualizó ningún tenant. " +
              "Revisa que tenantId coincida EXACTAMENTE con tenants.id"
          );
        }
      } catch (dbErr) {
        console.error(
          "❌ [WA EXCHANGE CODE] Error guardando access_token en tenants:",
          dbErr
        );
        return res
          .status(500)
          .json({ error: "Error al guardar access_token en DB." });
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error("❌ [WA EXCHANGE CODE] Error general:", err);
      return res
        .status(500)
        .json({ error: "Error interno intercambiando el code." });
    }
  }
);

/**
 * POST /api/meta/whatsapp/onboard-complete
 *
 * El frontend (página /meta/whatsapp-redirect) nos envía
 * wabaId + phoneNumberId cuando el Embedded Signup termina.
 * Aquí solo actualizamos el tenant.
 */
router.post(
  "/whatsapp/onboard-complete",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id as string | undefined;

      const { wabaId, phoneNumberId } = req.body as {
        wabaId?: string;
        phoneNumberId?: string;
      };

      console.log("[WA ONBOARD COMPLETE] Body recibido:", {
        wabaId,
        phoneNumberId,
        tenantId,
      });

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "No se pudo determinar el tenant (falta tenantId)." });
      }

      if (!wabaId || !phoneNumberId) {
        return res
          .status(400)
          .json({ error: "Faltan wabaId o phoneNumberId en el body." });
      }

      // Actualizar tenant en DB
      try {
        console.log(
          "💾 [WA ONBOARD COMPLETE] Actualizando tenant...",
          tenantId
        );

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
          phoneNumberId,
          tenantId,
        ]);

        console.log(
          "💾 [WA ONBOARD COMPLETE] UPDATE rowCount:",
          result.rowCount,
          "rows:",
          result.rows
        );

        if (result.rowCount === 0) {
          console.warn(
            "⚠️ [WA ONBOARD COMPLETE] No se actualizó ningún tenant. " +
              "Revisa que tenantId coincida EXACTAMENTE con tenants.id"
          );
        }

        return res.json({ ok: true, tenant: result.rows[0] });
      } catch (dbErr) {
        console.error(
          "❌ [WA ONBOARD COMPLETE] Error guardando datos de WhatsApp en tenants:",
          dbErr
        );
        return res
          .status(500)
          .json({ error: "Error al guardar datos de WhatsApp en DB." });
      }
    } catch (err) {
      console.error("❌ [WA ONBOARD COMPLETE] Error general:", err);
      return res
        .status(500)
        .json({ error: "Error interno en onboard-complete." });
    }
  }
);

/**
 * GET /api/meta/whatsapp/accounts
 *
 * Devuelve los números de WhatsApp conectados para el tenant autenticado.
 */
router.get(
  "/whatsapp/accounts",
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

      // 1) Leer tenant, incluyendo el access_token
      const { rows } = await pool.query(
        `SELECT
           id,
           name,
           whatsapp_business_id,
           whatsapp_phone_number_id,
           whatsapp_phone_number,
           whatsapp_access_token,
           whatsapp_status
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );

      const row = rows[0];
      if (!row) {
        return res.status(404).json({ error: "Tenant no encontrado." });
      }

      let {
        whatsapp_business_id,
        whatsapp_phone_number_id,
        whatsapp_phone_number,
        whatsapp_access_token,
        name,
      } = row as {
        whatsapp_business_id: string | null;
        whatsapp_phone_number_id: string | null;
        whatsapp_phone_number: string | null;
        whatsapp_access_token: string | null;
        name: string | null;
      };

      // Si ya tenemos número en DB, simplemente lo devolvemos
      if (whatsapp_phone_number_id && whatsapp_phone_number) {
        const phoneNumbers = [
          {
            waba_id: whatsapp_business_id,
            phone_number_id: whatsapp_phone_number_id,
            display_phone_number: whatsapp_phone_number,
            verified_name: name ?? null,
          },
        ];

        return res.json({
          phoneNumbers,
          accounts: phoneNumbers,
        });
      }

      // 2) Si NO hay número en DB pero SÍ hay access_token,
      //    llamamos a Graph para detectar el WABA y su número.
      if (!whatsapp_access_token) {
        // No hay token todavía: no podemos consultar a Meta
        return res.json({ phoneNumbers: [], accounts: [] });
      }

      try {
        console.log(
          "[WA ACCOUNTS] No hay número en DB, consultando a Meta con access_token…",
          { tenantId }
        );

        const resp = await fetch(
          "https://graph.facebook.com/v18.0/me" +
            "?fields=whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,code_verification_status}}" +
            `&access_token=${encodeURIComponent(whatsapp_access_token)}`
        );

        const json: any = await resp.json();
        console.log(
          "[WA ACCOUNTS] Respuesta /me whatsapp_business_accounts:",
          resp.status,
          JSON.stringify(json, null, 2)
        );

        if (!resp.ok || !json.whatsapp_business_accounts) {
          console.warn(
            "[WA ACCOUNTS] No se pudieron obtener whatsapp_business_accounts desde Meta."
          );
          return res.json({ phoneNumbers: [], accounts: [] });
        }

        const wabas: any[] = json.whatsapp_business_accounts.data || [];

        // Tomamos el primer WABA que tenga al menos un número
        let selectedWaba: any | null = null;
        let selectedPhone: any | null = null;

        for (const w of wabas) {
          const phones: any[] = w.phone_numbers?.data || w.phone_numbers || [];
          if (phones.length > 0) {
            // Preferir VERIFICADO si existe
            selectedPhone =
              phones.find(
                (p) =>
                  p.code_verification_status === "VERIFIED" ||
                  p.code_verification_status === "VERIFIED_WHATSAPP"
              ) || phones[0];
            selectedWaba = w;
            break;
          }
        }

        if (!selectedWaba || !selectedPhone) {
          console.warn(
            "[WA ACCOUNTS] No se encontró ningún WABA con números de WhatsApp."
          );
          return res.json({ phoneNumbers: [], accounts: [] });
        }

        whatsapp_business_id = selectedWaba.id;
        whatsapp_phone_number_id = selectedPhone.id;
        whatsapp_phone_number = selectedPhone.display_phone_number;

        // 3) Guardar en DB
        try {
          console.log(
            "[WA ACCOUNTS] Guardando número detectado en tenants…",
            {
              tenantId,
              whatsapp_business_id,
              whatsapp_phone_number_id,
              whatsapp_phone_number,
            }
          );

          await pool.query(
            `
            UPDATE tenants
            SET
              whatsapp_business_id     = $1,
              whatsapp_phone_number_id = $2,
              whatsapp_phone_number    = $3,
              updated_at               = NOW()
            WHERE id = $4
          `,
            [
              whatsapp_business_id,
              whatsapp_phone_number_id,
              whatsapp_phone_number,
              tenantId,
            ]
          );
        } catch (dbErr) {
          console.error(
            "[WA ACCOUNTS] Error guardando datos de número en DB:",
            dbErr
          );
          // seguimos, igual devolvemos lo que obtuvimos
        }

        const phoneNumbers = [
          {
            waba_id: whatsapp_business_id,
            phone_number_id: whatsapp_phone_number_id,
            display_phone_number: whatsapp_phone_number,
            verified_name: selectedPhone.verified_name || name || null,
          },
        ];

        return res.json({
          phoneNumbers,
          accounts: phoneNumbers,
        });
      } catch (errFetch) {
        console.error(
          "[WA ACCOUNTS] Error consultando cuentas de WhatsApp en Meta:",
          errFetch
        );
        return res
          .status(500)
          .json({ error: "Error consultando cuentas de WhatsApp en Meta." });
      }
    } catch (err) {
      console.error("[WA ACCOUNTS] Error general listando números:", err);
      return res
        .status(500)
        .json({ error: "Error listando cuentas de WhatsApp." });
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

      try {
        console.log(
          "💾 [WA OAUTH CALLBACK] Actualizando tenant con access_token...",
          tenantId
        );

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
          "❌ [WA OAUTH CALLBACK] Error guardando access_token en tenants:",
          dbErr
        );
        return res
          .status(500)
          .send("Error al guardar access_token en DB (ver logs).");
      }

      // Página simple para el popup
      return res.send(`
        <html>
          <head>
            <title>WhatsApp conectado</title>
          </head>
          <body style="font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; text-align:center; padding-top:40px;">
            <h1>✅ WhatsApp conectado correctamente</h1>
            <p>Ya registramos tu cuenta de WhatsApp Business en Aamy.</p>
            <p>Puedes cerrar esta ventana y volver al dashboard.</p>
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

export default router;
