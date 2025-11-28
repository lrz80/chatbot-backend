// src/routes/meta/whatsapp-phone-numbers.ts
import { Router, Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = Router();

/**
 * GET /api/meta/whatsapp/phone-numbers
 *
 * Lista los números disponibles para la WABA asociada al tenant actual.
 * - Usa el whatsapp_access_token y whatsapp_business_id (WABA ID) guardados en tenants.
 * - NO recorre todos los businesses; va directo a /{wabaId}/phone_numbers.
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

      // 1️⃣ Obtener access_token y WABA ID (whatsapp_business_id) desde la DB
      const { rows } = await pool.query(
        `
        SELECT
          whatsapp_access_token,
          whatsapp_business_id
        FROM tenants
        WHERE id = $1
        LIMIT 1
        `,
        [tenantId]
      );

      const accessToken = rows[0]?.whatsapp_access_token as string | undefined;
      const wabaId = rows[0]?.whatsapp_business_id as string | null | undefined;

      if (!accessToken) {
        console.warn("[WA PHONE NUMBERS] Sin whatsapp_access_token en tenant");
        return res.json({ accounts: [], status: "no_token" });
      }

      if (!wabaId) {
        console.warn(
          "[WA PHONE NUMBERS] Tenant sin whatsapp_business_id (WABA ID). No listamos números."
        );
        return res.json({ accounts: [], status: "no_waba_id" });
      }

      // 2️⃣ (Opcional) Traer info básica de la WABA (nombre, owner business)
      let businessId: string | null = null;
      let businessName: string | null = null;
      try {
        const wabaInfoResp = await fetch(
          `https://graph.facebook.com/v18.0/${encodeURIComponent(
            wabaId
          )}?fields=id,name,owner_business_info{business_name,id}&access_token=${encodeURIComponent(
            accessToken
          )}`
        );
        const wabaInfoJson: any = await wabaInfoResp.json();
        console.log(
          `[WA PHONE NUMBERS] Info WABA ${wabaId} =>`,
          JSON.stringify(wabaInfoJson, null, 2)
        );

        businessId =
          wabaInfoJson?.owner_business_info?.id ?? null;
        businessName =
          wabaInfoJson?.owner_business_info?.business_name ?? null;
      } catch (infoErr) {
        console.warn(
          `[WA PHONE NUMBERS] No se pudo obtener info adicional de la WABA ${wabaId}:`,
          infoErr
        );
      }

      // 3️⃣ Obtener los números de esa WABA
      const phoneResp = await fetch(
        `https://graph.facebook.com/v18.0/${encodeURIComponent(
          wabaId
        )}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`
      );
      const phoneData: any = await phoneResp.json();

      console.log(
        `[WA PHONE NUMBERS] /${wabaId}/phone_numbers =>`,
        JSON.stringify(phoneData, null, 2)
      );

      const phone_numbers: any[] = Array.isArray(phoneData?.data)
        ? phoneData.data
        : [];

      if (!phone_numbers.length) {
        console.warn(
          `[WA PHONE NUMBERS] WABA ${wabaId} sin phone_numbers configurados`
        );
        return res.json({ accounts: [], status: "no_numbers" });
      }

      const accounts = [
        {
          business_id: businessId,
          business_name: businessName,
          waba_id: wabaId,
          waba_type: "owned" as const,
          phone_numbers: phone_numbers.map((p: any) => ({
            phone_number_id: p.id,
            display_phone_number: p.display_phone_number,
            verified_name: p.verified_name,
          })),
        },
      ];

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
 * Aquí wabaId es el ID de la WABA (whatsapp_business_id en la tabla tenants).
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
          whatsapp_business_id     = $1, -- aquí guardamos el WABA ID
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
