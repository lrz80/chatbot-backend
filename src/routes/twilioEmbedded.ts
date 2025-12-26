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

        // Twilio devuelve auth token SOLO en la creación
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

      const { whatsapp_number_type } = req.body || {};
      const numberType = whatsapp_number_type === "personal" ? "personal" : "twilio";

      await pool.query(
        `UPDATE tenants
        SET whatsapp_mode = 'twilio',
            whatsapp_number_type = $1,
            whatsapp_status = 'pending'
        WHERE id = $2`,
        [numberType, tenant.id]
      );

      return res.json({
        ok: true,
        status: "pending",
        twilio_subaccount_sid: subaccountSid,
        whatsapp_number_type: numberType,
        message:
          "Subcuenta lista. Abre el popup de Meta (Embedded Signup) para conectar la WABA. No se requiere Twilio Console.",
      });

    } catch (err) {
      console.error("Error en start-embedded-signup:", err);
      return res.status(500).json({ error: "Error iniciando proceso de WhatsApp" });
    }
  }
);

router.post(
  "/api/twilio/whatsapp/embedded-signup/complete",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado en req.user" });

      const { waba_id, business_id } = req.body || {};
      if (!waba_id || !business_id) {
        return res.status(400).json({ error: "Faltan waba_id o business_id del Embedded Signup" });
      }

      const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
      if (!rows.length) return res.status(404).json({ error: "Tenant no encontrado" });

      const tenant = rows[0];

      const numberType = tenant.whatsapp_number_type === "personal" ? "personal" : "twilio";

      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error: "Subcuenta Twilio no lista. Ejecuta start-embedded-signup primero.",
        });
      }

      // Guardar WABA/Business en DB (para auditoría / debugging)
      await pool.query(
        `UPDATE tenants
         SET whatsapp_business_id = $1,
             meta_business_id = $2,
             whatsapp_mode = 'twilio',
             whatsapp_status = 'pending'
         WHERE id = $3`,
        [waba_id, business_id, tenant.id]
      );

      if (numberType === "personal") {
        // En modo personal, Meta maneja el número y OTP dentro del popup.
        // Tu app NO debe comprar número Twilio ni crear sender por Twilio.

        await pool.query(
          `UPDATE tenants
          SET whatsapp_status = 'connected',
              whatsapp_connected = true,
              whatsapp_connected_at = NOW()
          WHERE id = $1`,
          [tenant.id]
        );

        return res.json({
          ok: true,
          mode: "personal",
          status: "connected",
          message: "WhatsApp conectado en modo número personal (Meta).",
        });
      }

      // Cliente Twilio de subcuenta
      const subClient = twilio(tenant.twilio_subaccount_sid, tenant.twilio_subaccount_auth_token);

      // 1) Asegurar número Twilio asignado (mínimo para automación)
      // Si ya manejas números manualmente, aquí puedes reutilizar tenant.twilio_number.
      let e164 = tenant.twilio_number;

      if (!e164) {
        // Ejemplo: comprar un número SMS-capable en US
        // IMPORTANTE: ajusta búsqueda a tu mercado
        const available = await subClient.availablePhoneNumbers("US").local.list({
          smsEnabled: true,
          limit: 1,
        });

        if (!available.length) {
          return res.status(400).json({
            error: "No hay números Twilio SMS-capable disponibles para comprar automáticamente.",
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

      // 2) Crear Sender vía Senders API (aquí está la magia)
      // Endpoint v2 de Senders: POST /v2/Channels/Senders
      // Vamos a usar request() como haces en sync-sender.
      const webhookUrl = "https://api.aamy.ai/api/webhook/whatsapp"; // tu webhook real

      const createResp = await (subClient as any).request({
        method: "POST",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
        data: {
          sender_id: `whatsapp:${e164}`,   // whatsapp:+1...
          configuration: {
            waba_id: waba_id,
          },
          profile: {
            name: tenant.name || "Mi negocio", // display name
          },
          webhook: {
            callback_url: "https://api.aamy.ai/api/webhook/whatsapp",
            callback_method: "POST",
          },
        },
      });

      const sender = createResp.body;
      const senderSid = sender?.sid;

      if (!senderSid) {
        return res.status(500).json({
          error: "Twilio no devolvió sender sid al crear el sender.",
          raw: sender,
        });
      }

      // Guardar sender en DB
      await pool.query(
        `UPDATE tenants
         SET whatsapp_sender_sid = $1,
             whatsapp_status = 'pending'
         WHERE id = $2`,
        [senderSid, tenant.id]
      );

      return res.json({
        ok: true,
        status: sender?.status || "pending",
        whatsapp_sender_sid: senderSid,
        twilio_number: e164,
        message: "Sender creado automáticamente. Puede tardar en pasar a ONLINE/APPROVED.",
      });
    } catch (err: any) {
      console.error("❌ Error en embedded-signup/complete:", err);
      return res.status(err?.status || 500).json({
        error: "Error completando Embedded Signup (Twilio)",
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

router.post(
  "/api/twilio/whatsapp/verify-sender",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) return res.status(401).json({ error: "Tenant no encontrado" });

      const { code } = req.body || {};
      if (!code) return res.status(400).json({ error: "Falta code" });

      const { rows } = await pool.query(`SELECT * FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
      if (!rows.length) return res.status(404).json({ error: "Tenant no encontrado" });
      const tenant = rows[0];

      if (tenant.whatsapp_number_type === "personal") {
        return res.status(400).json({
          error: "Este tenant está en modo número personal. No aplica verify/sync de Twilio Sender.",
        });
      }

      if (!tenant.twilio_subaccount_sid || !tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({ error: "Subcuenta Twilio no lista" });
      }
      if (!tenant.whatsapp_sender_sid) {
        return res.status(400).json({ error: "No hay whatsapp_sender_sid para verificar" });
      }

      const subClient = twilio(tenant.twilio_subaccount_sid, tenant.twilio_subaccount_auth_token);

      // Update sender con verification code
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
 * 2) Sincronizar sender de WhatsApp:
 *    - Lista Senders con API v2 (Channels/Senders)
 *    - Busca el sender ONLINE/APPROVED/ACTIVE
 *    - Guarda sender SID (XE...), y el número en twilio_number (+E164)
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

      if (tenant.whatsapp_number_type === "personal") {
        return res.status(400).json({
          error: "Este tenant está en modo número personal. No aplica verify/sync de Twilio Sender.",
        });
      }

      if (!tenant.twilio_subaccount_sid) {
        return res.status(400).json({ error: "El tenant no tiene subcuenta Twilio" });
      }

      if (!tenant.twilio_subaccount_auth_token) {
        return res.status(400).json({
          error:
            "El tenant no tiene twilio_subaccount_auth_token guardado. Recorre start-embedded-signup nuevamente.",
        });
      }

      console.log("✅ SUBACCOUNT SID:", tenant.twilio_subaccount_sid);

      // Cliente Twilio REAL de la subcuenta
      const subClient = twilio(
        tenant.twilio_subaccount_sid,
        tenant.twilio_subaccount_auth_token
      );

      // List Senders (API v2)
      const r = await (subClient as any).request({
        method: "GET",
        uri: "https://messaging.twilio.com/v2/Channels/Senders",
        params: {
          Channel: "whatsapp",
          PageSize: 50,
          Page: 0,
        },
      });

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
            sender_id: s.sender_id,
          })),
          message:
            "Aún no hay sender ONLINE/APPROVED/ACTIVE en esta subcuenta. Revisa Twilio > WhatsApp Senders.",
        });
      }

      // ✅ En v2 el número viene en sender_id: "whatsapp:+1716..."
      const senderIdRaw =
        String(approved.sender_id || approved.senderId || approved.sender || "").trim();

      const withoutPrefix = senderIdRaw.toLowerCase().startsWith("whatsapp:")
        ? senderIdRaw.slice("whatsapp:".length)
        : senderIdRaw;

      const approvedE164 = withoutPrefix.startsWith("+")
        ? withoutPrefix
        : `+${withoutPrefix.replace(/\D/g, "")}`;

      if (!approvedE164 || approvedE164 === "+") {
        // Si llega aquí, el sender está ONLINE pero no pudimos parsear número (raro)
        console.log("⚠️ No pude parsear E164 desde sender_id:", senderIdRaw, approved);
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
