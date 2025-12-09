// src/routes/meta/whatsapp-accounts.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

type WaAccount = {
  business_id: string | null;
  business_name: string | null;
  waba_id: string;
  waba_name: string | null;
  phone_number_id: string;
  phone_number: string;
  verified_name: string | null;
};

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
 * Lógica:
 * 1) Verifica usuario y tenant.
 * 2) Consulta al tenant en BD:
 *    - Si YA tiene whatsapp_phone_number_id guardado → devolvemos ese número.
 *    - Si NO tiene número aún:
 *       - Usamos META_WA_ACCESS_TOKEN + META_WABA_ID para listar números desde Graph.
 *       - Los devolvemos para que el frontend permita seleccionar uno (POST /whatsapp/select-number).
 *
 * El frontend (ConnectWhatsAppButton) solo necesita saber:
 *  - Si hay al menos 1 número asignado al tenant → phoneNumbers.length > 0 → "conectado".
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

      // 1) Leer info del tenant desde la base de datos
      const { rows: tenantRows } = await pool.query(
        `
        SELECT
          id,
          whatsapp_business_id,
          whatsapp_phone_number_id,
          whatsapp_phone_number,
          whatsapp_status
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const tenant = tenantRows[0];

      if (!tenant) {
        console.warn("[WA ACCOUNTS] Tenant no encontrado en BD:", tenantId);
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      // Si el tenant YA tiene número asignado → devolvemos eso directamente
      if (tenant.whatsapp_phone_number_id && tenant.whatsapp_phone_number) {
        const accounts = [
          {
            business_id: tenant.whatsapp_business_id || null,
            business_name: null,
            waba_id: tenant.whatsapp_business_id || "",
            waba_name: null,
            phone_number_id: tenant.whatsapp_phone_number_id as string,
            phone_number: tenant.whatsapp_phone_number as string,
            verified_name: null,
          },
        ];

        const phoneNumbers = accounts.map((a) => ({
          waba_id: a.waba_id,
          phone_number_id: a.phone_number_id,
          phone_number: a.phone_number,
          verified_name: a.verified_name,
        }));

        console.log(
          "[WA ACCOUNTS] Tenant ya tiene número asignado. Devolviendo phoneNumbers:",
          phoneNumbers
        );

        return res.json({ accounts, phoneNumbers });
      }

      // 2) Si NO hay número en BD, consultamos a Meta para listar números disponibles
      console.log(
        "[WA ACCOUNTS] Tenant sin número asignado. Consultando números en WABA global…",
        tenantId
      );

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

      const accounts: WaAccount[] = phones.map((ph: any): WaAccount => ({
        business_id: null,
        business_name: null,
        waba_id: wabaId,
        waba_name: null,
        phone_number_id: ph.id as string,
        phone_number: ph.display_phone_number as string,
        verified_name: (ph.verified_name as string) ?? null,
      }));

      const phoneNumbers = accounts.map((a: WaAccount) => ({
        waba_id: a.waba_id,
        phone_number_id: a.phone_number_id,
        phone_number: a.phone_number,
        verified_name: a.verified_name,
      }));

      console.log(
        "[WA ACCOUNTS] Total cuentas/números encontrados (sin asignar aún):",
        accounts.length
      );

      // OJO:
      // - Aquí SOLO listamos opciones. La asignación real al tenant
      //   se hace con POST /whatsapp/select-number.
      // - Tu UI puede usar 'accounts' para que el usuario elija uno,
      //   y luego hacer POST /select-number con waba_id + phone_number_id + phone_number.

      return res.json({ accounts, phoneNumbers });
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
 *
 * Guarda en la tabla tenants el número de WhatsApp elegido para este tenant.
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

      console.log(
        "[WA SELECT] Tenant actualizado con selección manual:",
        rows[0]
      );

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
