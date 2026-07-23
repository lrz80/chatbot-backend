// src/routes/twilioVoiceSetup.ts

import { Router } from "express";
import twilio from "twilio";
import pool from "../lib/db";
import { authenticateUser } from "../middleware/auth";
import { ensureTwilioSubaccountForTenant } from "../lib/twilio/ensureTwilioSubaccountForTenant";

const router = Router();

const BACKEND_URL = process.env.BACKEND_URL || "https://api.aamy.ai";

router.post("/api/twilio/voice/setup", authenticateUser, async (req, res) => {
  try {
    const tenantId = (req as any).user?.tenant_id;

    if (!tenantId) {
      return res.status(401).json({
        error: "Tenant no encontrado en req.user",
      });
    }

    const tenantResult = await pool.query(
      `
      SELECT
        id,
        name,
        twilio_number,
        twilio_voice_number
      FROM tenants
      WHERE id = $1
      LIMIT 1
      `,
      [tenantId]
    );

    const tenant = tenantResult.rows[0];

    if (!tenant) {
      return res.status(404).json({
        error: "Tenant no encontrado",
      });
    }

    const twilioAccount = await ensureTwilioSubaccountForTenant(tenant.id);

    const subClient = twilio(
      twilioAccount.twilioSubaccountSid,
      twilioAccount.twilioSubaccountAuthToken
    );

    /*
     * Orden:
     * 1. Mantener el número Voice existente.
     * 2. Reutilizar el número de WhatsApp.
     * 3. Comprar un número Voice + SMS.
     *
     * Si el tenant ya tiene dos números distintos, no los reemplazamos.
     */
    let voiceNumber: string | null =
      tenant.twilio_voice_number ||
      tenant.twilio_number ||
      null;

    if (!voiceNumber) {
      const available = await subClient.availablePhoneNumbers("US").local.list({
        voiceEnabled: true,
        smsEnabled: true,
        limit: 1,
      });

      if (!available.length) {
        return res.status(400).json({
          error:
            "No hay números Twilio con capacidad Voice y SMS disponibles.",
        });
      }

      const purchased = await subClient.incomingPhoneNumbers.create({
        phoneNumber: available[0].phoneNumber,
        voiceUrl: `${BACKEND_URL}/webhook/voice-realtime`,
        voiceMethod: "POST",
        statusCallback: `${BACKEND_URL}/webhook/voice-status`,
        statusCallbackMethod: "POST",
      });

      voiceNumber = purchased.phoneNumber;
    } else {
      const existingNumbers =
        await subClient.incomingPhoneNumbers.list({
          phoneNumber: voiceNumber,
          limit: 1,
        });

      const existingNumber = existingNumbers[0];

      if (!existingNumber) {
        return res.status(409).json({
          error:
            "El número guardado para este tenant no existe dentro de su subcuenta Twilio.",
          phone_number: voiceNumber,
        });
      }

      const capabilities = (existingNumber as any).capabilities;

      if (capabilities && capabilities.voice === false) {
        return res.status(409).json({
          error:
            "El número de WhatsApp existente no tiene capacidad para llamadas de voz. Debe migrarse a un número compatible con Voice y SMS.",
          phone_number: voiceNumber,
        });
      }

      await subClient
        .incomingPhoneNumbers(existingNumber.sid)
        .update({
          voiceUrl: `${BACKEND_URL}/webhook/voice-realtime`,
          voiceMethod: "POST",
          statusCallback: `${BACKEND_URL}/webhook/voice-status`,
          statusCallbackMethod: "POST",
        });
    }

    await pool.query(
      `
      UPDATE tenants
      SET twilio_voice_number = $1
      WHERE id = $2
      `,
      [voiceNumber, tenant.id]
    );

    return res.json({
      ok: true,
      voice_enabled: true,
      twilio_voice_number: voiceNumber,
      twilio_subaccount_sid: twilioAccount.twilioSubaccountSid,
      reused_existing_number:
        Boolean(tenant.twilio_voice_number) ||
        Boolean(
          !tenant.twilio_voice_number &&
          tenant.twilio_number
        ),
    });
  } catch (error: any) {
    console.error("❌ Error en /api/twilio/voice/setup:", {
      message: error?.message,
      code: error?.code,
      status: error?.status,
      stack: error?.stack,
    });

    return res.status(error?.status || 500).json({
      error: "Error activando voz",
      details: error?.message,
    });
  }
});

export default router;