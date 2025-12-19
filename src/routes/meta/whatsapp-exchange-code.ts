import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();
const GRAPH_VERSION = "v18.0";

/**
 * Env vars
 * - META_APP_ID
 * - META_APP_SECRET
 *
 * NOTA:
 * Para Embedded Signup, lo importante es:
 * 1) Guardar access_token
 * 2) Esperar el webhook (ahí llega WABA_ID y PHONE_NUMBER_ID)
 */
const META_APP_ID =
  process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

/**
 * POST /api/meta/whatsapp/exchange-code
 * body: { code, tenantId?, redirectUri?, state? }
 *
 * - NO hacemos /me/businesses (evita Missing Permission)
 * - NO hacemos /{wabaId}/phone_numbers aquí
 * - Guardamos token y dejamos el tenant en "pending_webhook"
 */
router.post(
  "/whatsapp/exchange-code",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      const { code, state, redirectUri } = req.body || {};

      if (!tenantId) {
        return res.status(401).json({ ok: false, error: "No autenticado" });
      }
      if (!code) {
        return res.status(400).json({ ok: false, error: "Falta code" });
      }
      if (!META_APP_ID || !META_APP_SECRET) {
        return res.status(500).json({
          ok: false,
          error: "META_APP_ID o META_APP_SECRET faltan",
        });
      }

      console.log("🧪 [WA EXCHANGE CODE] tenantId:", tenantId);
      console.log("🧪 [WA EXCHANGE CODE] received:", {
        hasCode: !!code,
        hasState: !!state,
        hasRedirectUri: !!redirectUri,
      });

      /**
       * 1) Exchange code -> access_token
       *
       * IMPORTANTE:
       * - En OAuth estándar se usa redirect_uri.
       * - En algunos flujos Embedded Signup, Meta permite el exchange sin redirect_uri.
       * - Si en tu caso vuelve el 36008, la solución real es enviar EXACTAMENTE el mismo
       *   redirect_uri que usaste en el dialog. Pero este archivo está preparado
       *   para NO depender de redirect_uri para evitar el loop que estabas viendo.
       */
      const tokenUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(META_APP_SECRET)}` +
        `&code=${encodeURIComponent(code)}`;

      const tokenRes = await fetch(tokenUrl, { method: "GET" });
      const tokenJson: any = await tokenRes.json();

      if (!tokenRes.ok) {
        console.error("❌ [WA EXCHANGE CODE] token exchange failed:", tokenJson);
        return res.status(500).json({
          ok: false,
          error: "Error exchange code",
          detail: tokenJson,
        });
      }

      const accessToken = tokenJson?.access_token as string | undefined;
      const expiresIn = tokenJson?.expires_in as number | undefined;

      if (!accessToken) {
        return res.status(500).json({
          ok: false,
          error: "No access_token en respuesta",
          detail: tokenJson,
        });
      }

      /**
       * 2) Guardar token y marcar estado esperando webhook
       *
       * Recomendación:
       * - whatsapp_status = 'pending_webhook'
       * - whatsapp_connected = false hasta que llegue webhook con WABA/PHONE
       */
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_access_token = $1,
          whatsapp_status = 'pending_webhook',
          whatsapp_connected = false,
          whatsapp_connected_at = NULL,
          updated_at = NOW()
        WHERE id::text = $2
        `,
        [accessToken, tenantId]
      );

      console.log("✅ [WA EXCHANGE CODE] token saved. Waiting webhook.", {
        tenantId,
        expiresIn,
      });

      /**
       * 3) Responder OK
       * - El frontend puede recargar y mostrar "Conectado" solo cuando tengas
       *   whatsapp_phone_number_id y whatsapp_business_id guardados por el webhook.
       */
      return res.json({
        ok: true,
        status: "token_saved_waiting_webhook",
        expiresIn: expiresIn ?? null,
      });
    } catch (err) {
      console.error("❌ [WA EXCHANGE CODE] error:", err);
      return res.status(500).json({
        ok: false,
        error: "Error en exchange-code",
      });
    }
  }
);

export default router;
