// src/routes/meta/whatsapp-onboard.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db"; // ajusta el path si tu db.ts está en otro sitio
import { authenticateUser } from "../../middleware/auth"; // MISMO middleware que usas en /api/settings

const router = express.Router();

// ---- Tipos para la request autenticada ----
interface AuthedUser {
  uid: string;
  tenant_id: string;
  email?: string;
}

type AuthedRequest = Request & {
  user?: AuthedUser;
};

// ---- Ruta que recibe el POST del Embedded Signup ----
router.post(
  "/whatsapp-onboard",
  authenticateUser,
  async (req: AuthedRequest, res: Response) => {
    try {
      const tenantId = req.user?.tenant_id;

      if (!tenantId) {
        console.warn("[WA ONBOARD] Sin tenant_id en req.user");
        return res.status(401).json({ ok: false, error: "Unauthenticated" });
      }

      const body: any = req.body || {};
      console.log("[WA ONBOARD] Payload recibido:", JSON.stringify(body, null, 2));

      // Extraemos valores posibles del payload de Meta
      const wabaId =
        body.waba_id ||
        body.wa_waba_id ||
        body.raw?.wa_waba_id ||
        null;

      const phoneNumber =
        body.phone_number ||
        body.wa_phone_number ||
        body.raw?.phone_number ||
        null;

      const phoneNumberId =
        body.phone_number_id ||
        body.wa_phone_number_id ||
        body.raw?.wa_phone_number_id ||
        null;

      // Para Twilio-like sender_sid, de momento usamos el número como identificador
      const senderSid = phoneNumber || null;

      // ---- Actualizamos la fila del tenant ----
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_business_id     = COALESCE($2, whatsapp_business_id),
          whatsapp_phone_number    = COALESCE($3, whatsapp_phone_number),
          whatsapp_phone_number_id = COALESCE($4, whatsapp_phone_number_id),
          whatsapp_sender_sid      = COALESCE($5, whatsapp_sender_sid),
          whatsapp_status          = 'active'
        WHERE id = $1
        `,
        [tenantId, wabaId, phoneNumber, phoneNumberId, senderSid]
      );

      console.log("[WA ONBOARD] Datos guardados para tenant", tenantId);

      return res.json({
        ok: true,
        tenant_id: tenantId,
        waba_id: wabaId,
        phone_number: phoneNumber,
        phone_number_id: phoneNumberId,
        sender_sid: senderSid,
      });
    } catch (err) {
      console.error("[WA ONBOARD] Error guardando datos:", err);
      return res.status(500).json({ ok: false, error: "server_error" });
    }
  }
);

export default router;
