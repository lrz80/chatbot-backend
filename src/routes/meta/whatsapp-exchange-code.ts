import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

const GRAPH_VERSION = "v18.0";

// Embedded Signup (FB.login con config_id):
// ✅ NO uses redirect_uri en el exchange del code
const META_APP_ID =
  process.env.META_APP_ID || process.env.NEXT_PUBLIC_META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

/**
 * POST /api/meta/whatsapp/exchange-code
 * body: { code, tenantId?, redirectUri?, state? }
 *
 * Nota: redirectUri/state pueden venir del frontend, pero aquí NO se validan
 * para el exchange (para evitar el 36008).
 */
router.post(
  "/whatsapp/exchange-code",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      const { code } = req.body || {};

      if (!tenantId)
        return res.status(401).json({ ok: false, error: "No autenticado" });
      if (!code)
        return res.status(400).json({ ok: false, error: "Falta code" });

      if (!META_APP_ID || !META_APP_SECRET) {
        return res.status(500).json({
          ok: false,
          error: "META_APP_ID o META_APP_SECRET faltan",
        });
      }

      console.log("🧪 [WA EXCHANGE CODE] tenantId:", tenantId);

      // 1) Intercambiar code -> access_token (SIN redirect_uri)
      const tokenUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(META_APP_ID)}` +
        `&client_secret=${encodeURIComponent(META_APP_SECRET)}` +
        `&code=${encodeURIComponent(code)}`;

      const tokenRes = await fetch(tokenUrl, { method: "GET" });
      const tokenJson: any = await tokenRes.json();

      if (!tokenRes.ok) {
        return res.status(500).json({
          ok: false,
          error: "Error exchange code",
          detail: tokenJson,
        });
      }

      const accessToken = tokenJson?.access_token as string | undefined;
      if (!accessToken) {
        return res.status(500).json({
          ok: false,
          error: "No access_token en respuesta",
          detail: tokenJson,
        });
      }

      // 2) Guardar token en DB
      await pool.query(
        `
        UPDATE tenants
        SET whatsapp_access_token = $1, updated_at = NOW()
        WHERE id::text = $2
        `,
        [accessToken, tenantId]
      );

      // 3) Resolver WABA: /me/businesses -> owned/client wabas
      const bizUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/me/businesses` +
        `?fields=id,name,owned_whatsapp_business_accounts{id,name},client_whatsapp_business_accounts{id,name}`;

      const bizRes = await fetch(bizUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const bizJson: any = await bizRes.json();

      if (!bizRes.ok) {
        return res.status(500).json({
          ok: false,
          error: "Graph error en /me/businesses",
          detail: bizJson,
        });
      }

      const businesses = Array.isArray(bizJson?.data) ? bizJson.data : [];

      let pickedBusinessId: string | null = null;
      let pickedWabaId: string | null = null;

      for (const b of businesses) {
        const owned = b?.owned_whatsapp_business_accounts?.data || [];
        const client = b?.client_whatsapp_business_accounts?.data || [];
        const wabas = [
          ...(Array.isArray(owned) ? owned : []),
          ...(Array.isArray(client) ? client : []),
        ];

        if (wabas.length > 0) {
          pickedBusinessId = String(b.id);
          pickedWabaId = String(wabas[0].id);
          break;
        }
      }

      if (!pickedWabaId) {
        // Guardamos token igualmente, pero avisamos que no hay WABA visible con este token
        return res.json({
          ok: false,
          status: "no_waba_found",
          savedToken: true,
          businesses,
        });
      }

      // 4) Guardar WABA + Business en DB
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_manager_id = $1,
          whatsapp_business_id = $2,
          whatsapp_status = 'connected',
          whatsapp_connected = true,
          whatsapp_connected_at = NOW(),
          updated_at = NOW()
        WHERE id::text = $3
        `,
        [pickedBusinessId, pickedWabaId, tenantId]
      );

      // 5) Listar phone_numbers del WABA y guardar el primero (si existe)
      const pnUrl =
        `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
          pickedWabaId
        )}/phone_numbers` +
        `?fields=id,display_phone_number,verified_name,status,code_verification_status,quality_rating`;

      const pnRes = await fetch(pnUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const pnJson: any = await pnRes.json();

      const phoneNumbers = Array.isArray(pnJson?.data) ? pnJson.data : [];

      if (pnRes.ok && phoneNumbers.length > 0) {
        const firstPhoneNumberId = String(phoneNumbers[0].id);

        await pool.query(
          `
          UPDATE tenants
          SET whatsapp_phone_number_id = $1, updated_at = NOW()
          WHERE id::text = $2
          `,
          [firstPhoneNumberId, tenantId]
        );
      }

      return res.json({
        ok: true,
        status: "connected",
        picked: { businessManagerId: pickedBusinessId, wabaId: pickedWabaId },
        phoneNumbers,
      });
    } catch (err) {
      console.error("❌ [WA EXCHANGE CODE] error:", err);
      return res.status(500).json({ ok: false, error: "Error en exchange-code" });
    }
  }
);

export default router;
