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
        `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );

      if (!rows.length) return res.status(404).json({ error: "Tenant no encontrado" });

      const tenant = rows[0];

      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error:
            "Falta twilio_subaccount_sid o twilio_subaccount_auth_token. Ejecuta start-embedded-signup nuevamente.",
        });
      }

      // Cliente Twilio de la SUBCUENTA
      const subClient = twilio(
        tenant.twilio_subaccount_sid,
        tenant.twilio_subaccount_auth_token
      );

      // Llamada DIRECTA al endpoint real de senders v2
      const r = await (subClient as any).request({
        method: "GET",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
      });

      const body = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
      const senders = Array.isArray(body?.senders) ? body.senders : [];

      console.log("🌐 [TWILIO] Senders encontrados:", senders.length);
      console.log("🌐 [TWILIO] Sample sender:", senders[0]);

      // Detectar sender WhatsApp:
      let waSender = null;

      for (const s of senders) {
        const channel = String(s.channel || "").toLowerCase();
        const senderId =
          String(s.senderId || s.sender_id || s.address || "").toLowerCase();
        const status = String(s.status || "").toUpperCase();

        const isWhats = channel === "whatsapp" || senderId.startsWith("whatsapp:");

        const usable =
          status === "APPROVED" ||
          status === "ACTIVE" ||
          status === "ONLINE" ||
          status === "OFFLINE";

        if (isWhats && usable) {
          waSender = s;
          break;
        }
      }

      if (!waSender) {
        // Sender aún no está aprobado
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
          message:
            "No hay sender WhatsApp aprobado todavía. Puede demorar hasta 24 horas. Intenta sincronizar más tarde.",
          senders,
        });
      }

      // Extraer número WhatsApp del sender
      const senderIdRaw =
        waSender.senderId || waSender.sender_id || waSender.address || "";

      const phoneClean = senderIdRaw.toLowerCase().startsWith("whatsapp:")
        ? senderIdRaw.slice("whatsapp:".length).trim()
        : senderIdRaw;

      const phoneE164 = phoneClean.startsWith("+")
        ? phoneClean
        : `+${phoneClean.replace(/\D/g, "")}`;

      // Extraer el SID del sender (Twilio usa diferentes campos)
      const senderSid =
        waSender.sid ||
        waSender.senderSid ||
        waSender.sender_sid ||
        waSender.id ||
        senderIdRaw;

      // Guardar DEFINITIVO
      const upd = await pool.query(
        `UPDATE tenants
           SET whatsapp_sender_sid = $1,
               twilio_number = $2,
               whatsapp_mode = 'twilio',
               whatsapp_status = 'connected'
         WHERE id = $3
         RETURNING whatsapp_sender_sid, twilio_number, whatsapp_status`,
        [String(senderSid), phoneE164, tenant.id]
      );

      console.log("💾 [DB Updated] =>", upd.rows[0]);

      return res.json({
        ok: true,
        status: "connected",
        whatsapp_sender_sid: upd.rows[0]?.whatsapp_sender_sid,
        twilio_number: upd.rows[0]?.twilio_number,
        message: "WhatsApp Twilio conectado correctamente.",
      });
    } catch (err: any) {
      console.error("❌ Error en sync-sender:", err);
      return res.status(500).json({
        error: "Error sincronizando sender (Twilio)",
        details: err?.message,
      });
    }
  }
);

export default router;
