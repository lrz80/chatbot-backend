// src/routes/meta/whatsapp-onboard.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";
import { authenticateUser } from "../../middleware/auth";

const router = express.Router();

// No redefinimos Request, usamos el tipo que ya existe con req.user
router.post(
  "/whatsapp-onboard",
  authenticateUser,
  async (req: Request, res: Response) => {
    console.log("🔔 [WA ONBOARD] Llamada recibida en backend");
    console.log("👤 req.user:", req.user);

    try {
      // 1️⃣ Obtener tenant_id desde req.user (autenticado) o desde el body
      const tenantId =
        req.user?.tenant_id || (req.body.tenantId as string | undefined);

      if (!tenantId) {
        console.warn("⚠️ [WA ONBOARD] Sin tenant_id en req.user ni en body");
        return res.status(400).json({ ok: false, error: "Sin tenant_id" });
      }

      console.log("🏢 tenantId:", tenantId);

      // 2️⃣ Procesar payload recibido desde el frontend
      const body = req.body || {};
      console.log("📦 [WA ONBOARD] Payload recibido:", body);

      const wabaId = body.waba_id || body.wa_waba_id || null;
      const phoneNumberId =
        body.phone_number_id || body.wa_phone_number_id || null;
      const phoneNumber =
        body.phone_number || body.wa_phone_number || null;

      const accessToken =
        body.access_token || body.wa_persistent_token || null;

      if (!wabaId || !phoneNumberId || !phoneNumber) {
        console.warn("⚠️ [WA ONBOARD] Payload incompleto");
        return res
          .status(400)
          .json({ ok: false, error: "Faltan campos esenciales" });
      }

      console.log("📌 Datos procesados:", {
        wabaId,
        phoneNumberId,
        phoneNumber,
        accessToken,
      });

      // 3️⃣ Guardar en base de datos (tabla tenants)
      const query = `
        UPDATE tenants
        SET
          whatsapp_business_id = $1,
          whatsapp_phone_number = $2,
          whatsapp_phone_number_id = $3,
          whatsapp_access_token = $4,
          whatsapp_status = 'connected'
        WHERE tenant_id = $5
        RETURNING tenant_id;
      `;

      const values = [
        wabaId,
        phoneNumber,
        phoneNumberId,
        accessToken,
        tenantId,
      ];

      const result = await pool.query(query, values);

      console.log("💾 [WA ONBOARD] Guardado en DB:", result.rowCount);

      return res.json({ ok: true, tenantId });
    } catch (error: any) {
      console.error("❌ [WA ONBOARD] Error:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
);

export default router;
