// src/routes/meta/whatsapp-accounts.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

interface AuthedRequest extends Request {
  user?: {
    uid: string;
    tenant_id: string;
    email?: string;
  };
}

/**
 * GET /api/meta/whatsapp/accounts
 *
 * Versión simplificada:
 * - Verifica al usuario (authenticateUser)
 * - Verifica que el tenant exista y tenga whatsapp_access_token (que ya hizo el flujo)
 * - Usa un token maestro del backend (META_WA_ACCESS_TOKEN) para consultar
 *   /me?fields=whatsapp_business_accounts{...}
 * - NO usa businesses{...} → NO necesita business_management
 */
router.get(
  "/whatsapp/accounts",
  authenticateUser,
  async (req: AuthedRequest, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;

      if (!tenantId) {
        console.warn("[WA ACCOUNTS] Sin tenantId en req.user");
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1) Traer tenant (solo para validar que existe y que hizo el flujo)
      const { rows } = await pool.query(
        `
        SELECT whatsapp_access_token
        FROM tenants
        WHERE id = $1
        LIMIT 1
      `,
        [tenantId]
      );

      const tenant = rows[0];
      if (!tenant) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      const tenantAccessToken = tenant.whatsapp_access_token as string | null;

      if (!tenantAccessToken) {
        console.warn(
          "[WA ACCOUNTS] Tenant sin whatsapp_access_token. Primero debe conectar WhatsApp."
        );
        return res.status(400).json({
          error:
            "Este tenant aún no tiene un access_token de Meta. Primero conecta WhatsApp.",
        });
      }

      // 2) Usar el token maestro del backend (el que generaste en Meta)
      const accessToken = process.env.META_WA_ACCESS_TOKEN;
      if (!accessToken) {
        console.error("[WA ACCOUNTS] Falta META_WA_ACCESS_TOKEN en el servidor");
        return res.status(500).json({
          error: "Falta META_WA_ACCESS_TOKEN en el servidor",
        });
      }

      // 3) Llamar a /me?fields=whatsapp_business_accounts{...}
      const fields =
        "whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name,code_verification_status}}";

      const meUrl =
        "https://graph.facebook.com/v18.0/me" +
        `?fields=${encodeURIComponent(fields)}` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      console.log("[WA ACCOUNTS] Consultando /me:", meUrl);

      const meResp = await fetch(meUrl);
      const meJson: any = await meResp.json();

      console.log(
        "[WA ACCOUNTS] Respuesta /me:",
        meResp.status,
        JSON.stringify(meJson, null, 2)
      );

      if (!meResp.ok) {
        console.error("[WA ACCOUNTS] Error desde Graph:", meJson);
        return res.status(500).json({
          error: "Meta Graph devolvió un error al listar cuentas de WhatsApp",
          detail: meJson,
        });
      }

      // 4) Extraer WABAs y teléfonos desde whatsapp_business_accounts
      const wabas =
        meJson.whatsapp_business_accounts?.data ??
        meJson.whatsapp_business_accounts ??
        [];

      const accounts: Array<{
        business_id: string | null;
        business_name: string | null;
        waba_id: string;
        waba_name: string | null;
        phone_number_id: string;
        phone_number: string;
        verified_name: string | null;
      }> = [];

      for (const w of wabas) {
        const wabaId = w.id as string;
        const wabaName = (w.name as string) ?? null;

        const phones = w.phone_numbers?.data ?? w.phone_numbers ?? [];
        for (const ph of phones) {
          accounts.push({
            business_id: null, // aquí ya no tenemos businesses{...}
            business_name: null,
            waba_id: wabaId,
            waba_name: wabaName,
            phone_number_id: ph.id as string,
            phone_number: ph.display_phone_number as string,
            verified_name: (ph.verified_name as string) ?? null,
          });
        }
      }

      console.log(
        "[WA ACCOUNTS] Total cuentas/números encontrados:",
        accounts.length
      );

      return res.json({ accounts });
    } catch (err) {
      console.error("❌ [WA ACCOUNTS] Error inesperado:", err);
      return res.status(500).json({
        error: "Error interno al listar cuentas de WhatsApp",
      });
    }
  }
);

/**
 * POST /api/meta/whatsapp/select-number
 */
router.post(
  "/whatsapp/select-number",
  authenticateUser,
  async (req: AuthedRequest, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      const { waba_id, phone_number_id, phone_number } = req.body || {};

      if (!waba_id || !phone_number_id || !phone_number) {
        return res.status(400).json({
          error:
            "Faltan datos. Debes enviar waba_id, phone_number_id y phone_number en el body.",
        });
      }

      const updateQuery = `
        UPDATE tenants
        SET
          whatsapp_business_id      = $1,
          whatsapp_phone_number_id  = $2,
          whatsapp_phone_number     = $3,
          whatsapp_status           = 'connected',
          updated_at                = NOW()
        WHERE id = $4
        RETURNING id, whatsapp_business_id, whatsapp_phone_number_id, whatsapp_phone_number;
      `;

      const { rows } = await pool.query(updateQuery, [
        waba_id,
        phone_number_id,
        phone_number,
        tenantId,
      ]);

      console.log("[WA SELECT] Tenant actualizado con selección manual:", rows[0]);

      return res.json({ ok: true, tenant: rows[0] });
    } catch (err) {
      console.error("❌ [WA SELECT] Error inesperado:", err);
      return res.status(500).json({
        error: "Error interno al guardar el número seleccionado",
      });
    }
  }
);

export default router;
