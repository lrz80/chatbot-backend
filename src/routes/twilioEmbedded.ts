// src/routes/twilioEmbedded.ts
import { Router } from "express";
import twilio from "twilio";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import { ensureTwilioSubaccountForTenant } from "../lib/twilio/ensureTwilioSubaccountForTenant";

const router = Router();

const WHATSAPP_CALLBACK_URL = "https://api.aamy.ai/api/webhook/whatsapp";
const WHATSAPP_CALLBACK_METHOD = "POST";

async function findSenderById(subClient: any, senderId: string) {
  const r = await subClient.request({
    method: "GET",
    uri: "https://messaging.twilio.com/v2/Channels/Senders",
    params: { PageSize: 1000, Page: 0 },
  });

  const senders = (r.body?.senders ?? r.body?.data ?? []) as any[];
  return senders.find((s: any) => String(s.sender_id || "").toLowerCase() === senderId.toLowerCase()) || null;
}

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

      const twilioAccount = await ensureTwilioSubaccountForTenant(tenant.id);

      const subaccountSid = twilioAccount.twilioSubaccountSid;
      const subAuthToken = twilioAccount.twilioSubaccountAuthToken;

      // Cliente Twilio REAL de subcuenta
      const subClient = twilio(subaccountSid, subAuthToken);

      // 2) Asegurar un único número Twilio para WhatsApp y Voice.
      //
      // Orden:
      // 1. Mantener el número actual de WhatsApp, si ya existe.
      // 2. Reutilizar el número de Voice, si WhatsApp todavía no tiene número.
      // 3. Comprar un número nuevo con capacidad Voice + SMS.
      let e164: string | null =
        tenant.twilio_number ||
        tenant.twilio_voice_number ||
        null;

      if (numberType === "twilio" && !e164) {
        const available = await subClient.availablePhoneNumbers("US").local.list({
          voiceEnabled: true,
          smsEnabled: true,
          limit: 1,
        });

        if (!available.length) {
          return res.status(400).json({
            error:
              "No hay números Twilio con capacidad Voice y SMS disponibles para compra automática en la subcuenta.",
          });
        }

        const purchased = await subClient.incomingPhoneNumbers.create({
          phoneNumber: available[0].phoneNumber,
        });

        e164 = purchased.phoneNumber;
      }

      if (numberType === "twilio" && e164) {
        await pool.query(
          `
          UPDATE tenants
          SET twilio_number = $1
          WHERE id = $2
          `,
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
        partner_solution_id: process.env.TWILIO_PARTNER_SOLUTION_ID || null, // 👈 agrega esto
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

      const { waba_id, business_id, phone_number_id, raw } = req.body || {};

      if (!waba_id) {
        return res.status(400).json({ error: "Falta waba_id del Embedded Signup" });
      }

      // 1) Cargar tenant
      const { rows } = await pool.query(
        `SELECT * FROM tenants WHERE id = $1 LIMIT 1`,
        [tenantId]
      );
      if (!rows.length) return res.status(404).json({ error: "Tenant no encontrado" });
      const tenant = rows[0];

      // 2) Guardar datos Meta + fijar modo Twilio (NO falla aunque Twilio falle luego)
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
      const e164 = tenant.twilio_number;
      if (!e164) {
        // OJO: esto sí es un error real porque tu flujo Twilio-only depende del número comprado
        return res.status(400).json({
          error:
            "No hay twilio_number guardado. Ejecuta start-embedded-signup nuevamente para asignar un número.",
        });
      }

      // 5) Crear Sender en Twilio (si falla, NO tumbamos el onboarding)
      let senderSid: string | null = null;
      let senderStatus: string | null = null;
      let senderRaw: any = null;

      try {
        const payload = {
          sender_id: `whatsapp:${e164}`,
          profile: { name: tenant.name || "Mi negocio" },
          configuration: {
            waba_id: String(waba_id),
          },
          webhook: {
            callback_url: WHATSAPP_CALLBACK_URL,
            callback_method: WHATSAPP_CALLBACK_METHOD,
          },
        };

        const createResp = await (subClient as any).request({
          method: "POST",
          uri: "https://messaging.twilio.com/v2/Channels/Senders",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          data: JSON.stringify(payload), // ✅ CLAVE: enviar JSON string
        });

        const status = createResp?.statusCode || createResp?.status || 0;

        // Twilio a veces devuelve body string
        const body =
          typeof createResp?.body === "string" ? JSON.parse(createResp.body) : createResp?.body;

        senderRaw = { status, body, sent: payload };

        if (status < 200 || status >= 300) {
          console.error("❌ Twilio Sender create non-2xx:", { status, body });

          const existing = await findSenderById(subClient as any, `whatsapp:${e164}`);
          if (existing?.sid) {
            senderSid = existing.sid;
            senderStatus = existing.status ? String(existing.status) : "pending";
            senderRaw = {
              recovered: true,
              existing: { sid: senderSid, status: senderStatus },
              status,
              body,
            };
          } else {
            senderSid = null;
            senderStatus = "pending";
          }
        } else {
          senderSid = body?.sid || body?.sender_sid || body?.senderSid || null;
          senderStatus = body?.status ? String(body.status) : null;
        }
      } catch (e: any) {
        const status = e?.status || e?.statusCode;
        const msg = e?.message || "";

        console.error("⚠️ Twilio create sender error:", { status, msg });

        if (status === 409 || String(msg).toLowerCase().includes("already")) {
          const existing = await findSenderById(subClient as any, `whatsapp:${e164}`);
          if (existing?.sid) {
            senderSid = existing.sid;
            senderStatus = existing.status ? String(existing.status) : "pending";
            senderRaw = { recovered: true, existing: { sid: senderSid, status: senderStatus } };
          } else {
            senderRaw = { warning: "409 pero no se encontró sender en lista", status, msg };
          }
        } else {
          senderRaw = { warning: "Error creando sender (no fatal)", status, msg };
        }
      }

      // 6) Persistir sender si lo tenemos; si no, dejamos pending (sin 500)
      if (senderSid) {
        await pool.query(
          `UPDATE tenants
           SET whatsapp_sender_sid = $1,
               whatsapp_status = $2
           WHERE id = $3`,
          [senderSid, String(senderStatus || "pending"), tenant.id]
        );

        return res.json({
          ok: true,
          status: senderStatus || "pending",
          whatsapp_sender_sid: senderSid,
          twilio_number: e164,
          message:
            "Sender creado/registrado en Twilio. Puede tardar unos minutos en quedar ONLINE. Usa Sincronizar.",
          sender_raw: senderRaw,
        });
      }

      // ✅ NO FALLAR: devolver pending para que el usuario use Sync
      return res.json({
        ok: true,
        status: "pending",
        whatsapp_sender_sid: null,
        twilio_number: e164,
        message:
          "Embedded Signup OK, pero Twilio aún no devolvió sender SID (o hubo conflicto). Presiona Sincronizar en 1–3 minutos.",
        sender_raw: senderRaw,
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

      const expectedSenderId = tenant.twilio_number ? `whatsapp:${tenant.twilio_number}` : null;

      const target = expectedSenderId
        ? senders.find((s: any) => String(s.sender_id || "").toLowerCase() === expectedSenderId.toLowerCase())
        : null;

      if (!target) {
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
            "No se encontró el sender esperado para este tenant en la subcuenta. Verifica que el número coincida y reintenta.",
        });
      }

      const st = String(target.status || "").toUpperCase();
      const isApproved = st === "ONLINE" || st === "APPROVED" || st === "ACTIVE";

      if (!isApproved) {
        await pool.query(
          `UPDATE tenants
          SET whatsapp_status = 'pending',
              whatsapp_mode = 'twilio',
              whatsapp_sender_sid = COALESCE(whatsapp_sender_sid, $2)
          WHERE id = $1`,
          [tenant.id, target.sid]
        );

        return res.json({
          ok: true,
          status: "pending",
          sender: { sid: target.sid, status: target.status, sender_id: target.sender_id },
          message: "El sender correcto existe pero aún no está ONLINE/APPROVED/ACTIVE. Reintenta en 1–3 minutos.",
        });
      }

      // En v2 el número viene en sender_id: "whatsapp:+1716..."
      const senderIdRaw = String(
        target.sender_id || target.senderId || target.sender || ""
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
        [target.sid, approvedE164, tenant.id]
      );

      return res.json({
        ok: true,
        status: "connected",
        whatsapp_sender_sid: target.sid,
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

router.post(
  "/api/twilio/whatsapp/disconnect",
  authenticateUser,
  async (req, res) => {
    try {
      const tenantId = (req as any).user?.tenant_id;
      if (!tenantId) return res.status(401).json({ error: "No autorizado" });

      // Importante: no necesitas “borrar” Twilio en Twilio aquí.
      // Para el tenant, desconectar = Aamy deja de procesar mensajes
      // y marca el canal como desconectado en DB.
      await pool.query(
        `
        UPDATE tenants
        SET
          whatsapp_status = 'disconnected',
          whatsapp_connected = false,
          whatsapp_sender_sid = NULL,
          whatsapp_connected_at = NULL
        WHERE id = $1
        `,
        [tenantId]
      );

      return res.json({ ok: true, status: "disconnected" });
    } catch (e) {
      console.error("❌ /disconnect error:", e);
      return res.status(500).json({ error: "Error desconectando WhatsApp" });
    }
  }
);

export default router;
