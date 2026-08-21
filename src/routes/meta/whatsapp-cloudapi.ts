//src/routes/meta/whatsapp-cloudapi.ts
import { Router, Request, Response } from "express";
import { procesarMensajeWhatsApp } from "../webhook/whatsapp";
import {
  activateWhatsAppHumanTakeover,
  normalizeWhatsAppContactKey,
} from "../../lib/whatsapp/humanTakeover";

const router = Router();

/**
 * Meta VERIFY
 * GET /api/meta/whatsapp/cloudapi?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 */
router.get("/cloudapi", (req: Request, res: Response) => {
  const VERIFY_TOKEN = process.env.META_WA_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/**
 * Meta INBOUND
 * POST /api/meta/whatsapp/cloudapi
 */
router.post("/cloudapi", async (req: Request, res: Response) => {
  // Responder rápido a Meta
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const field = change?.field;

    /**
     * COEXISTENCE:
     *
     * Un mensaje enviado manualmente desde WhatsApp Business App
     * llega como smb_message_echoes.
     *
     * Esto NO lo genera un mensaje que Aamy envía por Cloud API.
     */
    if (field === "smb_message_echoes") {
      const metadata = value?.metadata;

      const phoneNumberId = String(
        metadata?.phone_number_id || ""
      ).trim();

      const echoes = Array.isArray(
        value?.message_echoes
      )
        ? value.message_echoes
        : [];

      for (const echo of echoes) {
        /*
        * En smb_message_echoes:
        *
        * from = número del negocio
        * to   = cliente
        *
        * Con las nuevas identidades de WhatsApp,
        * `to` puede no estar disponible en algunos casos,
        * por eso dejamos fallbacks.
        */
        const rawContactKey =
          echo?.to ||
          value?.contacts?.[0]?.wa_id ||
          echo?.to_user_id ||
          value?.contacts?.[0]?.user_id ||
          "";

        const contactKey =
          normalizeWhatsAppContactKey(rawContactKey);

        if (!phoneNumberId || !contactKey) {
          console.warn(
            "[WA CLOUDAPI][HUMAN TAKEOVER] Echo sin identidad suficiente",
            {
              phoneNumberId,
              hasContactKey: !!contactKey,
              messageId: echo?.id || null,
            }
          );

          continue;
        }

        try {
          const takeover =
            await activateWhatsAppHumanTakeover({
              phoneNumberId,
              contactKey,
              messageId: echo?.id || null,
            });

          console.log(
            "[WA CLOUDAPI][HUMAN TAKEOVER]",
            {
              phoneNumberId,
              contactKey,
              messageId: echo?.id || null,
              result: takeover,
            }
          );
        } catch (error: any) {
          console.error(
            "[WA CLOUDAPI][HUMAN TAKEOVER] Error:",
            error?.message || error
          );
        }
      }

      return;
    }

    const msg = value?.messages?.[0];
    const metadata = value?.metadata;

    if (!msg || !metadata) {
      const statuses = value?.statuses;

      if (Array.isArray(statuses) && statuses.length > 0) {
        console.log("[WA CLOUDAPI][STATUS]", {
          id: statuses[0]?.id,
          status: statuses[0]?.status,
          recipientId: statuses[0]?.recipient_id,
        });
        return;
      }

      console.log("[WA CLOUDAPI] evento ignorado", {
        field: change?.field,
      });

      return;
    }

    // ✅ IDENTIDAD del número del negocio en Cloud API
    const phoneNumberId = metadata?.phone_number_id || "";

    // ✅ Identidad del cliente
    const fromRaw = msg?.from || "";

    // ✅ Texto entrante (cubre botones/listas)
    const text =
      msg?.text?.body ||
      msg?.button?.text ||
      msg?.interactive?.button_reply?.title ||
      msg?.interactive?.list_reply?.title ||
      "";

    const metaMessageId = msg?.id || null;

    if (!phoneNumberId || !fromRaw || !text) {
      console.log("[WA CLOUDAPI] faltan datos", {
        phoneNumberId,
        fromRaw,
        hasText: !!text,
      });
      return;
    }

    // Normalizamos para reutilizar tu pipeline WhatsApp existente
    const normalized = {
      To: `whatsapp:${phoneNumberId}`, // ojo: aquí NO es número, es phone_number_id
      From: `whatsapp:+${String(fromRaw).replace(/^\+/, "")}`,
      Body: text,
      MetaMessageId: metaMessageId,
    };

    await procesarMensajeWhatsApp(normalized, {
      origen: "meta",
      canal: "whatsapp",
    });
  } catch (err) {
    console.error("❌ [WA CLOUDAPI] error:", err);
  }
});

export default router;
