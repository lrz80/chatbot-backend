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
        console.warn(
          "[WA ACCOUNTS] Tenant sin whatsapp_access_token. Primero debe conectar WhatsApp."
        );
        return res.json({ phoneNumbers: [], accounts: [] });
      }

      console.log(
        "[WA ACCOUNTS] No hay número en DB, consultando a Meta con access_token…",
        { tenantId }
      );

      // 2.1) Negocios a los que el usuario tiene acceso
      const businessesUrl =
        `https://graph.facebook.com/v18.0/me/businesses` +
        `?access_token=${encodeURIComponent(whatsapp_access_token)}`;

      console.log("[WA ACCOUNTS] Consultando /me/businesses:", businessesUrl);

      const businessesResp = await fetch(businessesUrl);
      const businessesJson: any = await businessesResp.json();

      console.log(
        "[WA ACCOUNTS] Respuesta /me/businesses:",
        businessesResp.status,
        JSON.stringify(businessesJson, null, 2)
      );

      if (!businessesResp.ok) {
        console.error("[WA ACCOUNTS] Error desde /me/businesses:", businessesJson);
        return res.status(500).json({
          error: "Meta Graph devolvió un error al listar negocios.",
          detail: businessesJson,
        });
      }

      const businesses = businessesJson.data ?? [];
      if (!Array.isArray(businesses) || businesses.length === 0) {
        console.warn(
          "[WA ACCOUNTS] El usuario no tiene negocios asociados en /me/businesses."
        );
        return res.json({ phoneNumbers: [], accounts: [] });
      }

      type FoundNumber = {
        business_id: string;
        waba_id: string;
        waba_name: string | null;
        phone_number_id: string;
        phone_number: string;
        verified_name: string | null;
      };

      let found: FoundNumber | null = null;

      // 2.2) Buscar la primera WABA con al menos un número
      for (const biz of businesses) {
        const businessId = biz.id as string;
        console.log(
          "[WA ACCOUNTS] Revisando business:",
          businessId,
          biz.name
        );

        const wabaEndpoints = [
          "owned_whatsapp_business_accounts",
          "client_whatsapp_business_accounts",
        ];

        for (const endpoint of wabaEndpoints) {
          const wabaUrl =
            `https://graph.facebook.com/v18.0/${businessId}/${endpoint}` +
            `?fields=id,name,phone_numbers{ id,display_phone_number,verified_name }` +
            `&access_token=${encodeURIComponent(whatsapp_access_token!)}`;

          console.log("[WA ACCOUNTS] Consultando:", wabaUrl);

          const wabaResp = await fetch(wabaUrl);
          const wabaJson: any = await wabaResp.json();

          console.log(
            `[WA ACCOUNTS] Respuesta ${endpoint}:`,
            wabaResp.status,
            JSON.stringify(wabaJson, null, 2)
          );

          if (!wabaResp.ok) {
            console.warn(
              `[WA ACCOUNTS] Error en ${endpoint} para business ${businessId}:`,
              wabaJson
            );
            continue;
          }

          const wabas = wabaJson.data ?? [];
          for (const w of wabas) {
            const phones = w.phone_numbers?.data ?? w.phone_numbers ?? [];
            if (!phones.length) continue;

            const ph = phones[0]; // por ahora tomamos el primero

            found = {
              business_id: businessId,
              waba_id: w.id as string,
              waba_name: (w.name as string) ?? null,
              phone_number_id: ph.id as string,
              phone_number: ph.display_phone_number as string,
              verified_name: (ph.verified_name as string) ?? null,
            };

            break;
          }

          if (found) break;
        }

        if (found) break;
      }

      if (!found) {
        console.warn(
          "[WA ACCOUNTS] No se encontraron WABAs con números en ninguno de los negocios."
        );
        return res.json({ phoneNumbers: [], accounts: [] });
      }

      console.log("[WA ACCOUNTS] Número encontrado automáticamente:", found);

      whatsapp_business_id = found.waba_id;
      whatsapp_phone_number_id = found.phone_number_id;
      whatsapp_phone_number = found.phone_number;

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
            whatsapp_status          = 'connected',
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
      }

      const phoneNumbers = [
        {
          waba_id: whatsapp_business_id,
          phone_number_id: whatsapp_phone_number_id,
          display_phone_number: whatsapp_phone_number,
          verified_name: found.verified_name || name || null,
        },
      ];

      return res.json({
        phoneNumbers,
        accounts: phoneNumbers,
      });
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
