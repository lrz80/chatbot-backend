// src/routes/twilioEmbedded.ts
import { Router } from "express";
import twilio from "twilio";
import pool from "../lib/db"; // AJUSTA si tu DB está en otra ruta
import { authenticateUser } from "../middleware/auth";

const router = Router();

// Cliente Twilio maestro
const masterClient = twilio(
  process.env.TWILIO_MASTER_ACCOUNT_SID!,
  process.env.TWILIO_MASTER_AUTH_TOKEN!
);

/**
 * 1) Iniciar (sin redirigir a Twilio):
 *    - Crea la subcuenta Twilio para el tenant si no existe
 *    - Deja whatsapp_mode='twilio' y whatsapp_status='pending'
 *    - Devuelve info para UI (sin signupUrl)
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

        // Nota: Twilio devuelve authToken SOLO en create account (response).
        subaccountSid = sub.sid;
        const subAuthToken = (sub as any).authToken || (sub as any).auth_token || null;

        if (!subAuthToken) {
          return res.status(500).json({
            error:
              "No se recibió authToken al crear la subcuenta. Revisa permisos/SDK. No puedo operar dentro de la subcuenta sin ese token.",
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

      // Marcar modo y estado
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
          "Subcuenta Twilio creada/validada. Ahora debes crear/aprobar el WhatsApp Sender en Twilio y luego presionar 'Sincronizar' para guardar el número en Aamy. La activación puede tardar hasta 24 horas.",
      });
    } catch (err: any) {
      console.error("❌ Error en start-embedded-signup:", {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        moreInfo: err?.moreInfo,
      });
      return res.status(500).json({ error: "Error iniciando proceso de WhatsApp (Twilio)" });
    }
  }
);

/**
 * 2) Sincronizar sender de WhatsApp:
 *    - Se llama cuando YA creaste/aprobaste el sender en Twilio (manual)
 *    - Lee Senders API v2 en la subcuenta
 *    - Si encuentra sender activo, guarda:
 *        whatsapp_sender_sid, twilio_number, whatsapp_status='connected', whatsapp_mode='twilio'
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
            "El tenant no tiene twilio_subaccount_auth_token guardado. Ejecuta start-embedded-signup nuevamente.",
        });
      }

      // Cliente Twilio REAL de la subcuenta
      const subClient = twilio(tenant.twilio_subaccount_sid, tenant.twilio_subaccount_auth_token);

      // ✅ Senders API v2 (WhatsApp) - listar senders
      const r = await (subClient as any).request({
        method: "GET",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
      });

      const body = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
      const senders = Array.isArray(body?.senders) ? body.senders : [];

      // Elegimos un sender WhatsApp usable.
      // En la práctica: ONLINE = listo; OFFLINE puede existir si está pausado pero ya creado.
      const approved = senders.find((s: any) => {
        const senderId = String(s?.senderId || "");
        const st = String(s?.status || "").toUpperCase();
        return senderId.toLowerCase().startsWith("whatsapp:") && (st === "ONLINE" || st === "OFFLINE");
      });

      if (!approved) {
        await pool.query(`UPDATE tenants SET whatsapp_status = 'pending', whatsapp_mode='twilio' WHERE id = $1`, [
          tenant.id,
        ]);

        return res.json({
          ok: true,
          status: "pending",
          senders,
          message:
            "Aún no hay un WhatsApp Sender activo en esta subcuenta. Si acabas de crearlo, puede tardar hasta 24 horas. Vuelve a presionar 'Sincronizar'.",
        });
      }

      // senderId viene como: "whatsapp:+17166213574"
      const senderId = String(approved.senderId || "");
      const phone = senderId.toLowerCase().startsWith("whatsapp:") ? senderId.slice("whatsapp:".length).trim() : senderId.trim();

      // Guardar todo en DB
      await pool.query(
        `UPDATE tenants
            SET whatsapp_sender_sid = $1,
                twilio_number = $2,
                whatsapp_mode = 'twilio',
                whatsapp_status = 'connected'
          WHERE id = $3`,
        [approved.sid, phone, tenant.id]
      );

      return res.json({
        ok: true,
        status: "connected",
        whatsapp_sender_sid: approved.sid,
        twilio_number: phone,
        message: "WhatsApp (Twilio) conectado correctamente.",
      });
    } catch (err: any) {
      console.error("❌ Error en sync-sender:", {
        message: err?.message,
        status: err?.status,
        code: err?.code,
        moreInfo: err?.moreInfo,
        details: err?.details,
      });

      return res.status(err?.status || 500).json({
        error: "Error sincronizando sender (Twilio)",
        twilio: {
          message: err?.message,
          status: err?.status,
          code: err?.code,
          moreInfo: err?.moreInfo,
        },
      });
    }
  }
);

export default router;
