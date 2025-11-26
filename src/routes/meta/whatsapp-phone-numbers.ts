import { Router, Request, Response } from "express";
import pool from "../../lib/db";

const router = Router();

router.get("/whatsapp-phone-numbers", async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const tenantId = user?.tenant_id;

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
      `https://graph.facebook.com/v18.0/me/businesses?access_token=${accessToken}`
    );
    const businessData: any = await businessResp.json();
    if (!businessData?.data?.length) {
      return res.json({ phoneNumbers: [], status: "no_business" });
    }
    const businessId = businessData.data[0].id;

    // 3️⃣ Obtener WABA IDs
    const wabaResp = await fetch(
      `https://graph.facebook.com/v18.0/${businessId}/owned_whatsapp_business_accounts?access_token=${accessToken}`
    );
    const wabaData: any = await wabaResp.json();
    if (!wabaData?.data?.length) {
      return res.json({ phoneNumbers: [], status: "no_waba" });
    }
    const wabaId = wabaData.data[0].id;

    // 4️⃣ Obtener números del WABA
    const phoneResp = await fetch(
      `https://graph.facebook.com/v18.0/${wabaId}/phone_numbers?access_token=${accessToken}`
    );
    const phoneData: any = await phoneResp.json();

    if (!phoneData?.data?.length) {
      return res.json({ phoneNumbers: [], status: "no_numbers" });
    }

    const phoneNumbers = phoneData.data.map((p: any) => ({
      phone_number_id: p.id,
      display_phone_number: p.display_phone_number,
      verified_name: p.verified_name,
      waba_id: wabaId,
    }));

    // 5️⃣ Opcional: guardar en DB
    await pool.query(
      `UPDATE tenants
       SET whatsapp_business_id = $1,
           whatsapp_phone_number_id = $2,
           whatsapp_phone_number = $3,
           updated_at = NOW()
       WHERE id = $4`,
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
    return res.status(500).json({ error: "Error consultando números de WhatsApp." });
  }
});

export default router;
