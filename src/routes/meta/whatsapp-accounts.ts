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

      // 👉 Ya no validamos whatsapp_access_token del tenant aquí.
      // Solo necesitamos que el usuario exista y esté autenticado.
      console.log("[WA ACCOUNTS] Listando números para tenant:", tenantId);

      // 1) Usar el token maestro del backend
      const accessToken = process.env.META_WA_ACCESS_TOKEN;
      const wabaId = process.env.META_WABA_ID;

      if (!accessToken || !wabaId) {
        console.error(
          "[WA ACCOUNTS] Falta META_WA_ACCESS_TOKEN o META_WABA_ID en env."
        );
        return res.status(500).json({
          error:
            "Configuración del servidor incompleta (META_WA_ACCESS_TOKEN / META_WABA_ID).",
        });
      }

      // 2) Llamar a /{WABA_ID}/phone_numbers
      const url =
        "https://graph.facebook.com/v18.0/" +
        encodeURIComponent(wabaId) +
        "/phone_numbers?access_token=" +
        encodeURIComponent(accessToken);

      console.log("[WA ACCOUNTS] Consultando phone_numbers:", url);

      const resp = await fetch(url);
      const json: any = await resp.json();

      console.log(
        "[WA ACCOUNTS] Respuesta phone_numbers:",
        resp.status,
        JSON.stringify(json, null, 2)
      );

      if (!resp.ok) {
        console.error("[WA ACCOUNTS] Error desde Graph:", json);
        return res.status(500).json({
          error: "Meta Graph devolvió un error al listar phone_numbers",
          detail: json,
        });
      }

      const phones = json.data ?? [];

      const accounts: Array<{
        business_id: string | null;
        business_name: string | null;
        waba_id: string;
        waba_name: string | null;
        phone_number_id: string;
        phone_number: string;
        verified_name: string | null;
      }> = [];

      for (const ph of phones) {
        accounts.push({
          business_id: null,
          business_name: null,
          waba_id: wabaId,
          waba_name: null,
          phone_number_id: ph.id as string,
          phone_number: ph.display_phone_number as string,
          verified_name: (ph.verified_name as string) ?? null,
        });
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
