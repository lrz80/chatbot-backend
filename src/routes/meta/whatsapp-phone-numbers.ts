// src/routes/meta/whatsapp-phone-numbers.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * GET /api/meta/whatsapp/phone-numbers
 *
 * Lista las WABA y números disponibles para el tenant actual.
 * - Usa el whatsapp_access_token guardado en tenants.
 * - NO usa /me/businesses ni owned_whatsapp_business_accounts
 *   para evitar el permiso business_management.
 * - NO guarda nada en la base de datos. Solo lista.
 */
router.get(
  "/whatsapp/phone-numbers",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId =
        (req as any).user?.tenant_id || (req as any).user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1️⃣ Obtener access_token desde la DB
      const { rows } = await pool.query(
        `SELECT whatsapp_access_token
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );

      const accessToken = rows[0]?.whatsapp_access_token as string | undefined;
      if (!accessToken) {
        console.warn("[WA PHONE NUMBERS] Sin whatsapp_access_token en tenant");
        return res.json({ accounts: [], status: "no_token" });
      }

      // 2️⃣ Consultar /me con whatsapp_business_accounts anidados
      const meUrl =
        `https://graph.facebook.com/v18.0/me` +
        `?fields=whatsapp_business_accounts{` +
        `id,name,` +
        `phone_numbers{id,display_phone_number,verified_name,code_verification_status}` +
        `}` +
        `&access_token=${encodeURIComponent(accessToken)}`;

      console.log("[WA PHONE NUMBERS] Consultando:", meUrl);

      const meResp = await fetch(meUrl);
      const meJson: any = await meResp.json();

      console.log(
        "[WA PHONE NUMBERS] Respuesta /me:",
        JSON.stringify(meJson, null, 2)
      );

      if (!meResp.ok) {
        console.error("[WA PHONE NUMBERS] Error desde Graph:", meJson);
        return res.status(500).json({
          error: "Meta Graph devolvió un error al listar cuentas de WhatsApp",
          detail: meJson,
        });
      }

      const wabas =
        meJson?.whatsapp_business_accounts?.data ??
        meJson?.whatsapp_business_accounts ??
        [];

      type Account = {
        waba_id: string;
        waba_name: string | null;
        phone_numbers: {
          phone_number_id: string;
          display_phone_number: string;
          verified_name: string | null;
          code_verification_status: string | null;
        }[];
      };

      const accounts: Account[] = [];

      for (const w of wabas) {
        const wabaId = String(w.id);
        const wabaName = (w.name as string) ?? null;

        const phones = w.phone_numbers?.data ?? w.phone_numbers ?? [];

        const phone_numbers = phones.map((p: any) => ({
          phone_number_id: String(p.id),
          display_phone_number: String(p.display_phone_number),
          verified_name: (p.verified_name as string) ?? null,
          code_verification_status:
            (p.code_verification_status as string) ?? null,
        }));

        // Si no hay teléfonos en esa WABA, no la agregamos
        if (phone_numbers.length > 0) {
          accounts.push({
            waba_id: wabaId,
            waba_name: wabaName,
            phone_numbers,
          });
        }
      }

      console.log(
        "[WA PHONE NUMBERS] Total WABAs con números encontrados:",
        accounts.length
      );

      if (!accounts.length) {
        return res.json({ accounts: [], status: "no_waba" });
      }

      // Solo devolvemos; NO guardamos nada
      return res.json({ accounts, status: "ok" });
    } catch (error) {
      console.error("[WA PHONE NUMBERS] Error inesperado:", error);
      return res
        .status(500)
        .json({ error: "Error consultando números de WhatsApp." });
    }
  }
);

/**
 * POST /api/meta/whatsapp/select-number
 *
 * Guarda en tenants el número y WABA que el cliente haya elegido en el dashboard.
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

      const { wabaId, phoneNumberId, displayPhoneNumber } = req.body as {
        wabaId?: string;
        phoneNumberId?: string;
        displayPhoneNumber?: string;
      };

      if (!wabaId || !phoneNumberId || !displayPhoneNumber) {
        return res.status(400).json({
          error: "Faltan wabaId, phoneNumberId o displayPhoneNumber",
        });
      }

      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1, -- aquí guardas el WABA ID
          whatsapp_phone_number_id = $2,
          whatsapp_phone_number    = $3,
          updated_at               = NOW()
        WHERE id = $4
        `,
        [wabaId, phoneNumberId, displayPhoneNumber, tenantId]
      );

      return res.json({ ok: true });
    } catch (err) {
      console.error("[WA SELECT NUMBER] Error:", err);
      return res.status(500).json({ error: "Error al guardar el número" });
    }
  }
);

export default router;
