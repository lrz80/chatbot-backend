// src/routes/meta/whatsapp-phone-numbers.ts
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
        return res.status(401).json({ error: "No autenticado" });
      }

      // 1️⃣ Obtener access_token desde la DB
      const { rows } = await pool.query(
        `SELECT whatsapp_access_token FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );

      const accessToken = rows[0]?.whatsapp_access_token;
      if (!accessToken) {
        return res.json({ phoneNumbers: [], status: "no_token" });
      }

      // 2️⃣ Obtener Business ID
      const businessResp = await fetch(
        `https://graph.facebook.com/v18.0/me/businesses?access_token=${encodeURIComponent(
          accessToken
        )}`
      );
      const businessData: any = await businessResp.json();

      console.log(
        "[WA PHONE NUMBERS] /me/businesses =>",
        JSON.stringify(businessData, null, 2)
      );

      if (!businessData?.data?.length) {
        return res.json({ phoneNumbers: [], status: "no_business" });
      }
      const businessId = businessData.data[0].id as string;

      // 3️⃣ Obtener WABA IDs
      const wabaResp = await fetch(
        `https://graph.facebook.com/v18.0/${encodeURIComponent(
          businessId
        )}/owned_whatsapp_business_accounts?access_token=${encodeURIComponent(
          accessToken
        )}`
      );
      const wabaData: any = await wabaResp.json();

      console.log(
        "[WA PHONE NUMBERS] owned_whatsapp_business_accounts =>",
        JSON.stringify(wabaData, null, 2)
      );

      if (!wabaData?.data?.length) {
        return res.json({ phoneNumbers: [], status: "no_waba" });
      }
      const wabaId = wabaData.data[0].id as string;

      // 4️⃣ Obtener números del WABA
      const phoneResp = await fetch(
        `https://graph.facebook.com/v18.0/${encodeURIComponent(
          wabaId
        )}/phone_numbers?access_token=${encodeURIComponent(accessToken)}`
      );
      const phoneData: any = await phoneResp.json();

      console.log(
        "[WA PHONE NUMBERS] /phone_numbers =>",
        JSON.stringify(phoneData, null, 2)
      );

      if (!phoneData?.data?.length) {
        return res.json({ phoneNumbers: [], status: "no_numbers" });
      }

      const phoneNumbers = phoneData.data.map((p: any) => ({
        phone_number_id: p.id,
        display_phone_number: p.display_phone_number,
        verified_name: p.verified_name,
        waba_id: wabaId,
      }));

      // 5️⃣ Opcional: guardar el primer número en tenants
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = $1,
          whatsapp_phone_number_id = $2,
          whatsapp_phone_number    = $3,
          updated_at               = NOW()
        WHERE id = $4
        `,
        [
          wabaId,
          phoneNumbers[0].phone_number_id,
          phoneNumbers[0].display_phone_number,
          tenantId,
        ]
      );

      return res.json({ phoneNumbers, status: "ok" });
    } catch (error) {
      console.error("[WA PHONE NUMBERS] Error:", error);
      return res
        .status(500)
        .json({ error: "Error consultando números de WhatsApp." });
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
