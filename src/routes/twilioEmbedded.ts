// src/routes/twilioEmbedded.ts
import { Router } from "express";
import twilio from "twilio";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = Router();

// Cliente Twilio maestro
const masterClient = twilio(
  process.env.TWILIO_MASTER_ACCOUNT_SID!,
  process.env.TWILIO_MASTER_AUTH_TOKEN!
);

/**
 * 1) Iniciar Embedded Signup:
 *    - Crea la subcuenta Twilio para el tenant si no existe
 *    - Marca modo/estado en DB
 */
router.post(
  "/api/twilio/whatsapp/start-embedded-signup",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en req.user" });
      }

      const { rows } = await pool.query(
        `SELECT *
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      const tenant = rows[0];
      let subaccountSid = tenant.twilio_subaccount_sid;

      // Crear subcuenta Twilio si no existe
      if (!subaccountSid) {
        const sub = await masterClient.api.accounts.create({
          friendlyName: `Tenant ${tenant.id} - ${tenant.name || ""}`,
        });

        // Twilio devuelve auth token en creación (solo en esa respuesta)
        subaccountSid = sub.sid;
        const subAuthToken = (sub as any).authToken || (sub as any).auth_token || null;

        if (!subAuthToken) {
          return res.status(500).json({
            error:
              "No se recibió authToken al crear la subcuenta. Revisa permisos/SDK (necesitas guardarlo para operar por subcuenta).",
          });
        }

        await pool.query(
          `UPDATE tenants
           SET twilio_subaccount_sid = $1,
               twilio_subaccount_auth_token = $2
           WHERE id = $3`,
          [subaccountSid, subAuthToken, tenant.id]
        );
      }

      await pool.query(
        `UPDATE tenants
         SET whatsapp_mode = 'twilio',
             whatsapp_status = 'pending'
         WHERE id = $1`,
        [tenant.id]
      );

      return res.json({
        ok: true,
        status: "pending",
        twilio_subaccount_sid: subaccountSid,
        message:
          "Subcuenta Twilio creada/validada. Completa el flujo en Twilio Console (WhatsApp Sender). Luego ejecuta sync-sender.",
      });
    } catch (err) {
      console.error("Error en start-embedded-signup:", err);
      return res.status(500).json({ error: "Error iniciando proceso de WhatsApp" });
    }
  }
);

/**
 * 2) Sincronizar sender de WhatsApp:
 *    - Lista Senders con API v2 (GET /v2/Channels/Senders)
 *    - Busca el sender ONLINE/APPROVED/ACTIVE
 *    - Guarda sender SID (XE...), y el número en twilio_number (+E164) desde sender_id
 */
router.post(
  "/api/twilio/whatsapp/sync-sender",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;

      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en req.user" });
      }

      const { rows } = await pool.query(
        `SELECT *
         FROM tenants
         WHERE id = $1
         LIMIT 1`,
        [tenantId]
      );

      if (!rows.length) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      const tenant = rows[0];

      if (!tenant.twilio_subaccount_sid) {
        return res.status(400).json({ error: "El tenant no tiene subcuenta Twilio" });
      }

      if (!tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error:
            "El tenant no tiene twilio_subaccount_auth_token guardado. Recorre start-embedded-signup nuevamente.",
        });
      }

      // Cliente Twilio REAL de la subcuenta
      const subClient = twilio(
        tenant.twilio_subaccount_sid,
        tenant.twilio_subaccount_auth_token
      );

      // ✅ API correcta (Senders API v2)
      const r = await (subClient as any).request({
        method: "GET",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
        params: {
          Channel: "whatsapp",
          PageSize: 50,
        },
      });

      console.log("✅ SUBACCOUNT SID:", tenant.twilio_subaccount_sid);
      console.log("📦 TWILIO senders raw body:", r.body);

      const senders = (r.body?.senders ?? r.body?.data ?? []) as any[];
      console.log("🌐 [TWILIO] Senders encontrados:", senders.length);

      // Busca sender “vivo”
      const approved = senders.find((s: any) => {
        const st = String(s.status || "").toUpperCase();
        return st === "ONLINE" || st === "APPROVED" || st === "ACTIVE";
      });

      if (!approved) {
        await pool.query(
          `UPDATE tenants
           SET whatsapp_status = 'pending',
               whatsapp_mode = 'twilio'
           WHERE id = $1`,
          [tenant.id]
        );

        return res.json({
          ok: true,
          status: "pending",
          senders: senders.map((s: any) => ({
            sid: s.sid,
            status: s.status,
            sender_id: s.sender_id, // <-- importante
          })),
          message:
            "Aún no hay sender ONLINE/APPROVED/ACTIVE en esta subcuenta. Espera o revisa el Error Log del Sender en Twilio Console.",
        });
      }

      // ✅ EL NÚMERO VIENE EN sender_id, NO en phoneNumber
      // Ej: sender_id = "whatsapp:+17166213574"
      const senderIdRaw = String(approved.sender_id || "");
      const approvedE164 = senderIdRaw.startsWith("whatsapp:")
        ? senderIdRaw.replace("whatsapp:", "")
        : senderIdRaw;

      if (!approvedE164 || !approvedE164.startsWith("+")) {
        return res.status(500).json({
          error: "Twilio devolvió un sender aprobado pero sin sender_id válido",
          approved: {
            sid: approved.sid,
            status: approved.status,
            sender_id: approved.sender_id,
          },
        });
      }

      // Guardar datos definitivos en tenants
      await pool.query(
        `UPDATE tenants
         SET whatsapp_sender_sid = $1,
             twilio_number = $2,
             whatsapp_mode = 'twilio',
             whatsapp_status = 'connected'
         WHERE id = $3`,
        [approved.sid, approvedE164, tenant.id]
      );

      return res.json({
        ok: true,
        status: "connected",
        whatsapp_sender_sid: approved.sid, // XE...
        twilio_number: approvedE164,       // +E164
        message: "WhatsApp Twilio conectado y número guardado correctamente.",
      });
    } catch (err) {
      console.error("❌ Error en sync-sender:", {
        message: (err as any)?.message,
        status: (err as any)?.status,
        code: (err as any)?.code,
        moreInfo: (err as any)?.moreInfo,
        details: (err as any)?.details,
      });

      return res.status((err as any)?.status || 500).json({
        error: "Error sincronizando sender (Twilio)",
        twilio: {
          message: (err as any)?.message,
          status: (err as any)?.status,
          code: (err as any)?.code,
          moreInfo: (err as any)?.moreInfo,
        },
      });
    }
  }
);

export default router;
