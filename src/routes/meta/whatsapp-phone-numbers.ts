import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * GET /api/meta/whatsapp/phone-numbers
 *
 * Devuelve los números de WhatsApp Business activos para el tenant actual.
 */
router.get(
  "/whatsapp/phone-numbers",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      if (!tenantId) {
        console.error("[WA PHONE NUMBERS] Sin tenantId en token");
        return res
          .status(401)
          .json({ error: "No se encontró tenantId en el usuario" });
      }

      // 1) Leer el access_token del tenant
      const { rows } = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id = $1
        `,
        [tenantId]
      );

      if (!rows.length || !rows[0].whatsapp_access_token) {
        return res.json({ phoneNumbers: [], status: "not_connected" });
      }

      const accessToken: string = rows[0].whatsapp_access_token;

      // 2) Obtener negocios y WABA del usuario de ese token
      const bizUrl =
        `https://graph.facebook.com/v18.0/me/businesses` +
        `?fields=id,name,owned_whatsapp_business_accounts{id,name}` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      const bizResp = await fetch(bizUrl);
      const bizJson: any = await bizResp.json();

      console.log(
        "[WA PHONE NUMBERS] /me/businesses =>",
        JSON.stringify(bizJson, null, 2)
      );

      if (!bizResp.ok) {
        console.error("[WA PHONE NUMBERS] Error en /me/businesses:", bizJson);
        return res
          .status(500)
          .json({ error: "Error al leer negocios de Meta" });
      }

      const businesses = bizJson.data || [];
      if (!Array.isArray(businesses) || businesses.length === 0) {
        return res.json({ phoneNumbers: [], status: "no_businesses" });
      }

      const firstBiz = businesses[0];
      const wabas = firstBiz.owned_whatsapp_business_accounts || [];

      if (!Array.isArray(wabas) || wabas.length === 0) {
        return res.json({ phoneNumbers: [], status: "no_waba" });
      }

      const wabaId = wabas[0].id as string;
      console.log("[WA PHONE NUMBERS] WABA detectado:", wabaId);

      // (Opcional) guardar el WABA en tenants
      try {
        await pool.query(
          `
          UPDATE tenants
          SET whatsapp_business_id = $1, updated_at = NOW()
          WHERE id = $2
          `,
          [wabaId, tenantId]
        );
      } catch (e) {
        console.warn(
          "[WA PHONE NUMBERS] No se pudo guardar whatsapp_business_id:",
          e
        );
      }

      // 3) Listar los números de ese WABA
      const phoneUrl =
        `https://graph.facebook.com/v18.0/${encodeURIComponent(
          wabaId
        )}/phone_numbers` +
        `?fields=id,display_phone_number,verified_name` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      const phoneResp = await fetch(phoneUrl);
      const phoneJson: any = await phoneResp.json();

      console.log(
        "[WA PHONE NUMBERS] /phone_numbers =>",
        JSON.stringify(phoneJson, null, 2)
      );

      if (!phoneResp.ok) {
        console.error(
          "[WA PHONE NUMBERS] Error en /phone_numbers:",
          phoneJson
        );
        return res
          .status(500)
          .json({ error: "Error al leer números de WhatsApp" });
      }

      const phoneNumbers = (phoneJson.data || []).map((p: any) => ({
        id: p.id,
        display_phone_number: p.display_phone_number,
        verified_name: p.verified_name,
      }));

      return res.json({ phoneNumbers, status: "ok" });
    } catch (err) {
      console.error("[WA PHONE NUMBERS] Error inesperado:", err);
      return res.status(500).json({ error: "Error interno" });
    }
  }
);

/**
 * POST /api/meta/whatsapp/select-number
 * body: { phoneNumberId: string, displayPhoneNumber: string }
 *
 * Guarda en tenants el número elegido por el tenant.
 */
router.post(
  "/whatsapp/select-number",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "No se encontró tenantId en el usuario" });
      }

      const { phoneNumberId, displayPhoneNumber } = req.body as {
        phoneNumberId?: string;
        displayPhoneNumber?: string;
      };

      if (!phoneNumberId || !displayPhoneNumber) {
        return res
          .status(400)
          .json({ error: "Faltan phoneNumberId o displayPhoneNumber" });
      }

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_phone_number_id = $1,
          whatsapp_phone_number    = $2,
          updated_at               = NOW()
        WHERE id = $3
        `,
        [phoneNumberId, displayPhoneNumber, tenantId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WA SELECT NUMBER] Error:", err);
      return res.status(500).json({ error: "Error al guardar el número" });
    }
  }
);

export default router;
