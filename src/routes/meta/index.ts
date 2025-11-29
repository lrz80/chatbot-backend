// src/routes/meta/index.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";
import whatsappCallback from "./whatsapp-callback";
import whatsappRedirect from "./whatsapp-redirect";
import whatsappPhoneNumbersRouter from "../meta/whatsapp-phone-numbers";

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
 * POST /api/meta/whatsapp-onboard/start
 *
 * Genera la URL de OAuth de Meta para conectar WhatsApp Cloud.
 * El frontend abre esta URL en un popup.
 */
router.post(
  "/whatsapp-onboard/start",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const APP_ID = process.env.META_APP_ID;
      const CONFIG_ID = process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;

      if (!APP_ID) {
        console.error("[WA ONBOARD START] Falta META_APP_ID en env");
        return res
          .status(500)
          .json({ error: "Falta configuración META_APP_ID en el servidor" });
      }

      if (!CONFIG_ID) {
        console.error(
          "[WA ONBOARD START] Falta META_EMBEDDED_SIGNUP_CONFIG_ID en env"
        );
        return res
          .status(500)
          .json({ error: "Falta configuración META_EMBEDDED_SIGNUP_CONFIG_ID" });
      }

      const tenantIdFromBody = (req.body as any)?.tenantId
        ? String((req.body as any).tenantId).trim()
        : undefined;

      const tenantId = tenantIdFromBody || (req as any).user?.tenant_id;

      if (!tenantId) {
        console.warn("[WA ONBOARD START] No se recibió tenantId");
        return res
          .status(400)
          .json({ error: "Falta tenantId para iniciar el onboarding" });
      }

      // 🔗 URL pública de tu backend
      const BACKEND_PUBLIC_URL =
        process.env.BACKEND_PUBLIC_URL || "https://api.aamy.ai";

      const redirectUri = `${BACKEND_PUBLIC_URL}/api/meta/whatsapp/callback`;

      // ✅ URL Meta-hosted Embedded Signup
      const url = new URL(
        "https://business.facebook.com/messaging/whatsapp/onboard/"
      );
      url.searchParams.set("app_id", APP_ID);
      url.searchParams.set("config_id", CONFIG_ID);
      url.searchParams.set("state", tenantId);
      // 👇 CLAVE: decirle a Meta a qué URL de tu backend debe volver
      url.searchParams.set("redirect_uri", redirectUri);

      console.log("[WA ONBOARD START] URL Embedded Signup:", url.toString());

      return res.json({ url: url.toString() });
    } catch (err) {
      console.error("❌ [WA ONBOARD START] Error inesperado:", err);
      return res
        .status(500)
        .json({ error: "No se pudo iniciar el onboarding de WhatsApp" });
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

      const { rows } = await pool.query(
        `SELECT
           whatsapp_business_id,
           whatsapp_phone_number_id,
           whatsapp_phone_number,
           name
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );

      const row = rows[0];
      if (!row) {
        return res.status(404).json({ error: "Tenant no encontrado." });
      }

      const phoneNumbers: Array<{
        waba_id: string | null;
        phone_number_id: string | null;
        display_phone_number: string | null;
        verified_name: string | null;
      }> = [];

      if (row.whatsapp_phone_number_id && row.whatsapp_phone_number) {
        phoneNumbers.push({
          waba_id: row.whatsapp_business_id ?? null,
          phone_number_id: row.whatsapp_phone_number_id ?? null,
          display_phone_number: row.whatsapp_phone_number ?? null,
          verified_name: row.name ?? null,
        });
      }

      return res.json({
        phoneNumbers,
        accounts: phoneNumbers,
      });
    } catch (err) {
      console.error("[WA ACCOUNTS] Error listando números:", err);
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

export default router;
