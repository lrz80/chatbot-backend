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
  subscribeAppToWaba,
  getSubscribedAppsFromWaba,
  graphGet,
} from "../../lib/meta/whatsappSystemUser";
import { getProviderToken } from "../../lib/meta/getProviderToken";
import whatsappSaveToken from "./whatsapp-save-token";
import whatsappResolveWaba from "./whatsapp-resolve-waba";

const router = Router();

/**
 * GET /api/meta/whatsapp/debug-number
 *
 * Debug seguro (requiere cookie/login):
 * - Lista phone_numbers del WABA guardado en DB
 * - Lee detalles del phone_number_id guardado en DB
 */
router.get(
  "/whatsapp/debug-number",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no identificado" });
      }

      // 1) Leer de DB: token + wabaId + phoneNumberId
      const t = await pool.query(
        `
        SELECT
          whatsapp_access_token,
          whatsapp_business_id,
          whatsapp_phone_number_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenantToken: string | null = t.rows?.[0]?.whatsapp_access_token || null;
      const wabaId: string | null = t.rows?.[0]?.whatsapp_business_id || null;
      const phoneNumberId: string | null = t.rows?.[0]?.whatsapp_phone_number_id || null;

      if (!wabaId) {
        return res.status(400).json({ error: "Falta whatsapp_business_id (wabaId) en tenant" });
      }
      if (!phoneNumberId) {
        return res.status(400).json({ error: "Falta whatsapp_phone_number_id en tenant" });
      }

      // Para debug consistente tipo Tech Provider, usamos el token del proveedor
      const providerToken = getProviderToken();

      const list = await graphGet(
        `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating,platform_type&limit=200`,
        providerToken
      );

      const subscribedApps = await graphGet(
        `${wabaId}/subscribed_apps?fields=id,name,subscribed_fields`,
        providerToken
      );

      const detail = await graphGet(
        `${phoneNumberId}?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating,platform_type`,
        providerToken
      );

      // 4) Responder JSON completo
      return res.json({
        ok: true,
        tenantId,
        wabaId,
        phoneNumberId,
        waba_phone_numbers: list,
        phone_number_detail: detail,
        subscribed_apps: subscribedApps,
      });
    } catch (err: any) {
      console.error("❌ [WA DEBUG NUMBER] Error:", err);
      return res.status(500).json({
        error: "Error interno debug-number",
        detail: String(err?.message || err),
      });
    }
  }
);

/**
 * POST /api/meta/whatsapp/test-send
 * Envía un mensaje desde el phone_number_id del tenant hacia un número destino.
 * Body: { to: "+1XXXXXXXXXX", text: "hola" }
 */
router.post(
  "/whatsapp/test-send",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user: any = (req as any).user;
      const tenantId: string | undefined = user?.tenant_id;

      if (!tenantId) return res.status(401).json({ error: "Tenant no identificado" });

      const { to, text } = req.body || {};
      if (!to) return res.status(400).json({ error: "Falta 'to' en body (E.164, ej: +1407...)" });

      const messageText = String(text || "ping desde Aamy Cloud API");

      // 1) Leer token + phoneNumberId del tenant
      const t = await pool.query(
        `
        SELECT whatsapp_access_token, whatsapp_phone_number_id
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      // 2) Extraer el phoneNumberId del tenant (NECESARIO para el endpoint /{phoneNumberId}/messages)
      const phoneNumberId: string | null = t.rows?.[0]?.whatsapp_phone_number_id || null;

      if (!phoneNumberId) {
        return res.status(400).json({ error: "Tenant sin whatsapp_phone_number_id" });
      }

      // ⚠️ Para enviar mensajes NO uses el token del tenant.
      // Usa el token del proveedor (System User / Tech Provider).
      const providerToken = getProviderToken();

      // 3) Payload del mensaje
      const payload = {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: messageText },
      };

      const resp = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${providerToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        }
      );

      const json: any = await resp.json().catch(() => ({}));

      console.log("🧪 [WA TEST SEND] status:", resp.status);
      console.log("🧪 [WA TEST SEND] response:", JSON.stringify(json, null, 2));

      if (!resp.ok) {
        return res.status(500).json({
          error: "Graph error enviando mensaje",
          status: resp.status,
          detail: json,
        });
      }

      return res.json({ ok: true, result: json });
    } catch (err: any) {
      console.error("❌ [WA TEST SEND] Error:", err);
      return res.status(500).json({ error: "Error interno test-send", detail: String(err?.message || err) });
    }
  }
);

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

      // 1.5) Guardar wabaId + phoneNumberId inmediatamente (aunque falle después)
      // Esto evita quedar “a medias” y te deja trazabilidad en DB.
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1,
          whatsapp_phone_number_id = $2,
          updated_at               = NOW()
        WHERE id::text = $3
        `,
        [wabaId, phoneNumberId, tenantId]
      );

      // 1.2) Suscribir la app al WABA (clave para que lleguen webhooks inbound)
      try {
        const providerToken = getProviderToken();
        const sub = await subscribeAppToWaba(wabaId, providerToken);
        console.log("✅ [WA ONBOARD COMPLETE] subscribed_apps OK:", sub);
      } catch (e: any) {
        console.warn("⚠️ [WA ONBOARD COMPLETE] subscribed_apps FAIL:", e?.message || e);
      }

      // 1.3) Verificar que el WABA quedó realmente suscrito
      try {
        const providerToken = getProviderToken();
        const apps = await getSubscribedAppsFromWaba(wabaId, providerToken);

        console.log(
          "🔍 [WA ONBOARD COMPLETE] subscribed_apps LIST:",
          JSON.stringify(apps, null, 2)
        );

        const appId = process.env.META_APP_ID;

        const isSubscribed =
          Array.isArray(apps?.data) &&
          apps.data.some((a: any) =>
            String(a?.id || a?.whatsapp_business_api_data?.id) === String(appId)
          );

        if (!isSubscribed) {
          console.error("❌ [WA ONBOARD COMPLETE] App NO está suscrita al WABA (o Graph devolvió shape distinto)");
        } else {
          console.log("✅ [WA ONBOARD COMPLETE] App confirmada en subscribed_apps");
        }
      } catch (e: any) {
        console.error(
          "❌ [WA ONBOARD COMPLETE] Error leyendo subscribed_apps:",
          e?.message || e
        );
      }

      // 2) Resolver Business Manager ID dueño del WABA
      // const businessManagerId = await resolveBusinessIdFromWaba(wabaId, tenantToken);

      // 4) Crear System User Token (scopes WA)
      const appId = process.env.META_APP_ID;
      if (!appId) {
        return res.status(500).json({ error: "Falta META_APP_ID en env." });
      }

      const update = await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_status           = 'connected',
          whatsapp_connected        = TRUE,
          whatsapp_connected_at     = NOW(),
          updated_at                = NOW()
        WHERE id::text = $3
        RETURNING
          id,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_status,
          whatsapp_connected,
          whatsapp_connected_at;
        `,
        [wabaId, phoneNumberId, tenantId]
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

router.post(
  "/whatsapp/save-token",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      const { whatsapp_access_token } = req.body;

      console.log("[WA SAVE TOKEN] tenantId:", tenantId);
      console.log("[WA SAVE TOKEN] token exists?:", !!whatsapp_access_token);

      if (!tenantId || !whatsapp_access_token) {
        return res.status(400).json({ error: "Datos incompletos" });
      }

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          updated_at = NOW()
        WHERE id = $2
        `,
        [whatsapp_access_token, tenantId]
      );

      console.log("[WA SAVE TOKEN] Token guardado en tenants");

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WA SAVE TOKEN] Error:", err);
      return res.status(500).json({ error: "Error guardando token" });
    }
  }
);

// ✅ Descubre WABAs con el token del tenant y guarda whatsapp_business_id
router.get(
  "/whatsapp/resolve-waba",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const user = (req as any).user;
      const tenantId = user?.tenant_id;

      console.log("🧪 [WA RESOLVE WABA] tenantId:", tenantId);

      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1) Leer token del tenant
      const t = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id::text = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const accessToken: string | null =
        t.rows?.[0]?.whatsapp_access_token || null;

      console.log("🧪 [WA RESOLVE WABA] has accessToken:", !!accessToken);

      if (!accessToken) {
        return res.status(400).json({ error: "Tenant no tiene whatsapp_access_token" });
      }

      // 2) Buscar negocios del usuario y sus WABAs
      // Nota: Esto requiere business_management (ya lo estás pidiendo).
      const url =
        `https://graph.facebook.com/v18.0/me/businesses` +
        `?fields=id,name,owned_whatsapp_business_accounts.limit(50){id,name}` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      console.log("🧪 [WA RESOLVE WABA] GET:", url);

      const resp = await fetch(url);
      const json: any = await resp.json();

      console.log("🧪 [WA RESOLVE WABA] Graph status:", resp.status);
      console.log("🧪 [WA RESOLVE WABA] Graph json:", JSON.stringify(json, null, 2));

      if (!resp.ok) {
        return res.status(500).json({
          error: "Graph error resolviendo businesses/WABAs",
          detail: json,
        });
      }

      const businesses = Array.isArray(json?.data) ? json.data : [];

      const wabas: { business_id: string; business_name: string; waba_id: string; waba_name: string | null }[] = [];

      for (const b of businesses) {
        const owned = b?.owned_whatsapp_business_accounts?.data || [];
        for (const w of owned) {
          wabas.push({
            business_id: String(b.id),
            business_name: String(b.name || ""),
            waba_id: String(w.id),
            waba_name: (w.name as string) ?? null,
          });
        }
      }

      console.log("🧪 [WA RESOLVE WABA] total wabas encontrados:", wabas.length);

      if (wabas.length === 0) {
        return res.json({ ok: false, status: "no_wabas_found", wabas: [] });
      }

      // 3) Si solo hay 1 WABA, lo guardamos automáticamente
      if (wabas.length === 1) {
        const only = wabas[0];

        await pool.query(
          `
          UPDATE tenants
          SET whatsapp_business_id = $1,
              updated_at = NOW()
          WHERE id::text = $2
          `,
          [only.waba_id, tenantId]
        );

        console.log("✅ [WA RESOLVE WABA] Guardado whatsapp_business_id:", only.waba_id);

        return res.json({ ok: true, status: "saved", waba: only, wabas });
      }

      // 4) Si hay múltiples, devolvemos lista para que el front elija
      return res.json({ ok: true, status: "multiple", wabas });
    } catch (err: any) {
      console.error("❌ [WA RESOLVE WABA] Error:", err);
      return res.status(500).json({ error: "Error interno resolve-waba", detail: String(err?.message || err) });
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
router.use("/", whatsappSaveToken);
router.use("/", whatsappResolveWaba);

export default router;
