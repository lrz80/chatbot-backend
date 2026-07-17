// src/routes/facebook/webhook.ts
import express, { type Request, type Response } from "express";
import pool from "../../lib/db";

import { requireChannel } from "../../middleware/requireChannel";
import { canUseChannel } from "../../lib/features";
import { enviarMensajePorPartes } from "../../lib/enviarMensajePorPartes";
import { stripMarkdownLinksForDm } from "../../lib/channels/format/stripMarkdownLinks";
import {
  procesarMensajeWhatsApp,
  type MessagingProcessorContext,
} from "../webhook/whatsapp";

type CanalMeta = "facebook" | "instagram";

type MetaInboundEvent = {
  pageId: string;
  senderId: string;
  messageId: string;
  userInput: string;
};

const router = express.Router();

const GLOBAL_ID =
  process.env.GLOBAL_CHANNEL_TENANT_ID ||
  "00000000-0000-0000-0000-000000000001";

async function isMetaSubChannelEnabled(
  tenantId: string,
  canal: CanalMeta,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT facebook_enabled, instagram_enabled
       FROM channel_settings
      WHERE tenant_id = $1 OR tenant_id = $2
      ORDER BY CASE WHEN tenant_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [tenantId, GLOBAL_ID],
  );

  const row = rows[0];
  if (!row) return true;

  return canal === "facebook"
    ? row.facebook_enabled !== false
    : row.instagram_enabled !== false;
}

async function resolveMetaTenant(pageId: string): Promise<{
  tenant: any;
  canal: CanalMeta;
  accessToken: string;
} | null> {
  const { rows } = await pool.query(
    `SELECT t.*
       FROM tenants t
      WHERE t.facebook_page_id = $1
         OR t.instagram_page_id = $1
      LIMIT 1`,
    [pageId],
  );

  const tenant = rows[0];
  if (!tenant) return null;

  const canal: CanalMeta =
    tenant.instagram_page_id &&
    String(tenant.instagram_page_id) === String(pageId)
      ? "instagram"
      : "facebook";

  const accessToken = String(tenant.facebook_access_token || "").trim();
  if (!accessToken) {
    console.warn("⚠️ [META] tenant sin access token", {
      tenantId: tenant.id,
      canal,
      pageId,
    });
    return null;
  }

  return { tenant, canal, accessToken };
}

async function canProcessMetaInbound(
  tenant: any,
  canal: CanalMeta,
): Promise<boolean> {
  const tenantId = String(tenant?.id || "").trim();
  if (!tenantId) return false;

  if (!(await isMetaSubChannelEnabled(tenantId, canal))) {
    return false;
  }

  try {
    const gate = await canUseChannel(tenantId, "meta");

    if (!gate.plan_enabled || gate.reason === "paused") {
      return false;
    }
  } catch (error) {
    console.warn("⚠️ [META] canUseChannel falló; bloqueo por seguridad", {
      tenantId,
      canal,
      error,
    });
    return false;
  }

  const membershipActive =
    tenant.membresia_activa === true ||
    tenant.membresia_activa === "true" ||
    tenant.membresia_activa === 1;

  return membershipActive;
}

function createMetaSender(params: {
  canal: CanalMeta;
  accessToken: string;
  inboundMessageId: string;
}): NonNullable<MessagingProcessorContext["sendText"]> {
  return async (to, text, tenantId) => {
    const cleanText = stripMarkdownLinksForDm(String(text || "").trim());
    if (!cleanText) return false;

    await enviarMensajePorPartes({
      respuesta: cleanText,
      senderId: to,
      tenantId,
      canal: params.canal,
      messageId: `out_${params.inboundMessageId}`,
      accessToken: params.accessToken,
    });

    return true;
  };
}

async function processMetaInbound(event: MetaInboundEvent): Promise<void> {
  const resolved = await resolveMetaTenant(event.pageId);
  if (!resolved) return;

  const { tenant, canal, accessToken } = resolved;

  if (!(await canProcessMetaInbound(tenant, canal))) {
    return;
  }

  /*
   * Adaptamos el evento de Meta al contrato de entrada que ya consume
   * buildTurnContext dentro del procesador compartido.
   */
  const compatibleBody = {
    Body: event.userInput,
    From: event.senderId,
    WaId: event.senderId,
    MessageSid: event.messageId,
    SmsMessageSid: event.messageId,
    NumMedia: "0",
  };

  await procesarMensajeWhatsApp(compatibleBody, {
    tenant,
    canal,
    origen: "meta",
    sendText: createMetaSender({
      canal,
      accessToken,
      inboundMessageId: event.messageId,
    }),
  });
}

router.get(
  "/api/facebook/webhook",
  requireChannel("meta"),
  (req: Request, res: Response) => {
    const verifyToken = process.env.META_VERIFY_TOKEN;
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (!verifyToken) {
      console.error("❌ META_VERIFY_TOKEN no está configurado");
      return res.sendStatus(500);
    }

    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  },
);

router.post("/api/facebook/webhook", (req: Request, res: Response) => {
  // Meta exige una respuesta inmediata.
  res.sendStatus(200);

  const body = req.body;
  if (body?.object !== "page" && body?.object !== "instagram") {
    return;
  }

  for (const entry of body.entry || []) {
    const pageId = String(entry?.id || "").trim();
    if (!pageId) continue;

    for (const messagingEvent of entry?.messaging || []) {
      const message = messagingEvent?.message;
      const senderId = String(messagingEvent?.sender?.id || "").trim();
      const messageId = String(message?.mid || "").trim();
      const userInput =
        typeof message?.text === "string" ? message.text.trim() : "";

      if (!senderId || !messageId || !userInput) continue;
      if (message?.is_echo === true) continue;
      if (senderId === pageId) continue;

      void processMetaInbound({
        pageId,
        senderId,
        messageId,
        userInput,
      }).catch((error) => {
        console.error("❌ [META] processMetaInbound failed", {
          pageId,
          senderId,
          messageId,
          error,
        });
      });
    }
  }
});

export default router;