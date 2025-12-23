//src/routes/meta/whatsapp-cloudapi.ts
import { Router, Request, Response } from "express";
import { procesarMensajeWhatsApp } from "../webhook/whatsapp";

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

    const msg = value?.messages?.[0];
    const metadata = value?.metadata;

    if (!msg || !metadata) {
      console.log("[WA CLOUDAPI] payload sin messages/metadata");
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
