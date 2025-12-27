// src/routes/twilioEmbedded.ts
import { Router } from "express";
import twilio from "twilio";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";

const router = Router();

// Cliente Twilio maestro (cuenta principal)
const masterClient = twilio(
  process.env.TWILIO_MASTER_ACCOUNT_SID!,
  process.env.TWILIO_MASTER_AUTH_TOKEN!
);

const WHATSAPP_CALLBACK_URL = "https://api.aamy.ai/api/webhook/whatsapp";
const WHATSAPP_CALLBACK_METHOD = "POST";

/**
 * 1) Iniciar Embedded Signup (Twilio-only):
 *    - Asegura subcuenta Twilio por tenant (Modelo B)
 *    - Asegura número Twilio (E164) en la subcuenta ANTES del popup (recomendado)
 *    - Marca estado pending
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
        `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      const tenant = rows[0];

      // En Twilio-only, este valor debe ser siempre 'twilio'
      const whatsappMode = "twilio";

      // number_type: (por si en el futuro soportas non-twilio numbers dentro de Twilio)
      // por defecto en Twilio-only: "twilio"
      const { whatsapp_number_type } = req.body || {};
      const numberType = whatsapp_number_type === "non_twilio" ? "non_twilio" : "twilio";

      let subaccountSid = tenant.twilio_subaccount_sid;
      let subAuthToken = tenant.twilio_subaccount_auth_token;

      // 1) Crear subcuenta Twilio si no existe
      if (!subaccountSid || !subAuthToken) {
        const sub = await masterClient.api.accounts.create({
          friendlyName: `Tenant ${tenant.id} - ${tenant.name || ""}`.trim(),
        });

        subaccountSid = sub.sid;
        // Twilio devuelve auth token SOLO en la creación (según SDK)
        subAuthToken = (sub as any).authToken || (sub as any).auth_token || null;

        if (!subAuthToken) {
          return res.status(500).json({
            error:
              "No se recibió authToken al crear la subcuenta. Debes guardarlo para operar por subcuenta.",
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

      // Cliente Twilio REAL de subcuenta
      const subClient = twilio(subaccountSid, subAuthToken);

      // 2) Asegurar número Twilio (solo si numberType === 'twilio')
      // Recomendación: elegir/asignar el número ANTES de abrir el popup.
      let e164 = tenant.twilio_number;

      if (numberType === "twilio" && !e164) {
        const available = await subClient.availablePhoneNumbers("US").local.list({
          smsEnabled: true,
          limit: 1,
        });

        if (!available.length) {
          return res.status(400).json({
            error:
              "No hay números Twilio SMS-capable disponibles para compra automática en la subcuenta.",
          });
        }

        const purchased = await subClient.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
        });

        e164 = purchased.phoneNumber;

        await pool.query(
          `UPDATE tenants
           SET twilio_number = $1
           WHERE id = $2`,
          [e164, tenant.id]
        );
      }

      // 3) Marcar estado del onboarding
      await pool.query(
        `UPDATE tenants
         SET whatsapp_mode = $1,
             whatsapp_number_type = $2,
             whatsapp_status = 'pending'
         WHERE id = $3`,
        [whatsappMode, numberType, tenant.id]
      );

      return res.json({
        ok: true,
        status: "pending",
        whatsapp_mode: whatsappMode,
        whatsapp_number_type: numberType,
        twilio_subaccount_sid: subaccountSid,
        twilio_number: e164 || null,
        message:
          "Subcuenta lista. Número (si aplica) asignado. Ahora abre el popup de Meta (Embedded Signup) con Partner Solution ID.",
      });
    } catch (err) {
      console.error("Error en start-embedded-signup:", err);
      return res.status(500).json({ error: "Error iniciando proceso de WhatsApp (Twilio)" });
    }
  }
);

/**
 * 2) Completar Embedded Signup (Twilio-only):
 *    - Guarda IDs de Meta (WABA / Business / PhoneNumberId si llega)
 *    - Registra WhatsApp Sender en Twilio (Senders API) usando subcuenta
 */
router.post(
  "/api/twilio/whatsapp/embedded-signup/complete",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) {
        return res.status(401).json({ error: "Tenant no encontrado en req.user" });
      }

      const { waba_id, business_id, phone_number_id } = req.body || {};

      if (!waba_id) {
        return res.status(400).json({ error: "Falta waba_id del Embedded Signup" });
      }

      // 1) Cargar tenant
      const { rows } = await pool.query(
        `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }
      const tenant = rows[0];

      const numberType = tenant.whatsapp_number_type === "non_twilio" ? "non_twilio" : "twilio";

      // 2) Guardar datos Meta + fijar modo Twilio
      await pool.query(
        `UPDATE tenants
         SET whatsapp_business_id = $1,
             meta_business_id = $2,
             whatsapp_phone_number_id = $3,
             whatsapp_mode = 'twilio',
             whatsapp_status = 'pending'
         WHERE id = $4`,
        [waba_id, business_id || null, phone_number_id || null, tenant.id]
      );

      // 3) Validar subcuenta
      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error: "Subcuenta Twilio no configurada. Ejecuta start-embedded-signup primero.",
        });
      }

      const subClient = twilio(
        tenant.twilio_subaccount_sid,
        tenant.twilio_subaccount_auth_token
      );

      // 4) Determinar sender_id whatsapp:+E164
      // Twilio-only recomendado: usar número Twilio comprado en start-embedded-signup.
      const e164 = tenant.twilio_number;

      if (numberType === "twilio") {
        if (!e164) {
          return res.status(400).json({
            error:
              "No hay twilio_number guardado. Ejecuta start-embedded-signup nuevamente para asignar un número.",
          });
        }
      } else {
        // Si soportas non-twilio numbers en el futuro, aquí deberías traer el E164 del usuario desde UI.
        // Por ahora, forzamos error para no quedar en un estado inconsistente.
        return res.status(400).json({
          error:
            "whatsapp_number_type=non_twilio no está habilitado en Twilio-only. Usa número Twilio.",
        });
      }

      // 5) Crear Sender de WhatsApp en Twilio (Senders API)
      const createResp = await (subClient as any).request({
        method: "POST",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
        data: {
          sender_id: `whatsapp:${e164}`,
          configuration: {
            waba_id: waba_id,
          },
          profile: {
            name: tenant.name || "Mi negocio",
          },
          webhook: {
            callback_url: WHATSAPP_CALLBACK_URL,
            callback_method: WHATSAPP_CALLBACK_METHOD,
          },
        },
      });

      const sender = createResp.body;
      const senderSid = sender?.sid;

      if (!senderSid) {
        return res.status(500).json({
          error: "Twilio no devolvió sender SID.",
          raw: sender,
        });
      }

      // 6) Guardar sender + status
      await pool.query(
        `UPDATE tenants
         SET whatsapp_sender_sid = $1,
             whatsapp_status = $2
         WHERE id = $3`,
        [senderSid, String(sender?.status || "pending"), tenant.id]
      );

      return res.json({
        ok: true,
        mode: "twilio_only",
        status: sender?.status || "pending",
        whatsapp_sender_sid: senderSid,
        twilio_number: e164,
        message:
          "Sender creado en Twilio (subcuenta). Puede tardar unos minutos en quedar ONLINE. Usa sync-sender para confirmar.",
      });
    } catch (err: any) {
      console.error("❌ Error en embedded-signup/complete:", err);
      return res.status(500).json({
        error: "Error completando Embedded Signup (Twilio)",
        details: err?.message,
      });
    }
  }
);

/**
 * 3) (Opcional) Verify sender con código
 * NOTA: Solo aplica si algún día habilitas números non-Twilio.
 * Para Twilio-only con números Twilio, normalmente NO se usa.
 */
router.post(
  "/api/twilio/whatsapp/verify-sender",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

      const { code } = req.body || {};
      if (!code) return res.status(400).json({ error: "Falta code" });

      const { rows } = await pool.query(
        `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      if (!rows.length) return res.status(404).json({ error: "Tenant no encontrado" });
      const tenant = rows[0];

      // Si Twilio-only solo usa números Twilio, bloquea esta ruta para evitar confusión.
      if ((tenant.whatsapp_number_type || "twilio") === "twilio") {
        return res.status(400).json({
          error:
            "verify-sender no aplica para números Twilio. Usa sync-sender y espera a ONLINE.",
        });
      }

      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({ error: "Subcuenta Twilio no lista" });
      }
      if (!tenant.whatsapp_sender_sid) {
        return res.status(400).json({ error: "No hay whatsapp_sender_sid para verificar" });
      }

      const subClient = twilio(tenant.twilio_subaccount_sid, tenant.twilio_subaccount_auth_token);

      const upd = await (subClient as any).request({
        method: "POST",
        uri: `https://messaging.twilio.com/v2/Channels/Senders/${tenant.whatsapp_sender_sid}`,
        data: {
          configuration: {
            verification_code: String(code).trim(),
          },
        },
      });

      return res.json({
        ok: true,
        status: upd?.body?.status || "pending",
        sender: {
          sid: upd?.body?.sid,
          status: upd?.body?.status,
        },
        message: "Código enviado a Twilio. Espera a que pase a ONLINE.",
      });
    } catch (err: any) {
      console.error("❌ Error verify-sender:", err);
      return res.status(err?.status || 500).json({
        error: "Error verificando sender (Twilio)",
        twilio: {
          message: err?.message,
          status: err?.status,
          code: err?.code,
          moreInfo: err?.moreInfo,
          details: err?.details,
        },
      });
    }
  }
);

/**
 * 4) Sync sender:
 *    - Lista Senders (v2/Channels/Senders)
 *    - Busca sender ONLINE/APPROVED/ACTIVE
 *    - Guarda sender SID y set whatsapp_status='connected'
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

      if (!rows.length) {
        return res.status(404).json({ error: "Tenant no encontrado" });
      }

      const tenant = rows[0];

      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error: "El tenant no tiene subcuenta Twilio lista (SID/AuthToken).",
        });
      }

      const subClient = twilio(
        tenant.twilio_subaccount_sid,
        tenant.twilio_subaccount_auth_token
      );

      const r = await (subClient as any).request({
        method: "GET",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
        params: {
          Channel: "whatsapp",
          PageSize: 50,
          Page: 0,
        },
      });

      const senders = (r.body?.senders ?? r.body?.data ?? []) as any[];

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
            sender_id: s.sender_id,
          })),
          message:
            "Aún no hay sender ONLINE/APPROVED/ACTIVE en esta subcuenta. Reintenta en 1-3 minutos.",
        });
      }

      // En v2 el número viene en sender_id: "whatsapp:+1716..."
      const senderIdRaw = String(
        approved.sender_id || approved.senderId || approved.sender || ""
      ).trim();

      const withoutPrefix = senderIdRaw.toLowerCase().startsWith("whatsapp:")
        ? senderIdRaw.slice("whatsapp:".length)
        : senderIdRaw;

      const approvedE164 = withoutPrefix.startsWith("+")
        ? withoutPrefix
        : `+${withoutPrefix.replace(/\D/g, "")}`;

      await pool.query(
        `UPDATE tenants
         SET whatsapp_sender_sid = $1,
             twilio_number = COALESCE(twilio_number, $2),
             whatsapp_mode = 'twilio',
             whatsapp_status = 'connected',
             whatsapp_connected = true,
             whatsapp_connected_at = NOW()
         WHERE id = $3`,
        [approved.sid, approvedE164, tenant.id]
      );

      return res.json({
        ok: true,
        status: "connected",
        whatsapp_sender_sid: approved.sid,
        twilio_number: tenant.twilio_number || approvedE164,
        message: "WhatsApp Twilio conectado (sender ONLINE/APPROVED/ACTIVE).",
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
