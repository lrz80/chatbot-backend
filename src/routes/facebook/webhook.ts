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

async function processMetaInbound(
  event: MetaInboundEvent
): Promise<void> {
  console.log("[META][PROCESSING_STARTED]", {
    pageId: event.pageId,
    senderId: event.senderId,
    messageId: event.messageId,
  });

  const resolved = await resolveMetaTenant(event.pageId);

  if (!resolved) {
    console.warn("[META][TENANT_NOT_RESOLVED]", {
      pageId: event.pageId,
      senderId: event.senderId,
      messageId: event.messageId,
    });
    return;
  }

  const { tenant, canal, accessToken } = resolved;

  console.log("[META][TENANT_RESOLVED]", {
    tenantId: tenant.id,
    canal,
    pageId: event.pageId,
    hasAccessToken: Boolean(accessToken),
  });

  const canProcess = await canProcessMetaInbound(
    tenant,
    canal
  );

  if (!canProcess) {
    console.warn("[META][CHANNEL_GATE_BLOCKED]", {
      tenantId: tenant.id,
      canal,
      membershipActive: tenant?.membresia_activa ?? null,
    });
    return;
  }

  const compatibleBody = {
    Body: event.userInput,
    From: event.senderId,
    WaId: event.senderId,
    MessageSid: event.messageId,
    SmsMessageSid: event.messageId,
    NumMedia: "0",
  };

  console.log("[META][SHARED_PIPELINE_DISPATCH]", {
    tenantId: tenant.id,
    canal,
    senderId: event.senderId,
    messageId: event.messageId,
  });

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
  console.log("[META][WEBHOOK_RECEIVED]", {
    method: req.method,
    originalUrl: req.originalUrl,
    contentType: req.headers["content-type"] ?? null,
    object: req.body?.object ?? null,
    entryCount: Array.isArray(req.body?.entry)
      ? req.body.entry.length
      : 0,
  });

  // Meta exige respuesta inmediata.
  res.sendStatus(200);

  const body = req.body;

  if (body?.object !== "page" && body?.object !== "instagram") {
    console.warn("[META][UNSUPPORTED_OBJECT]", {
      object: body?.object ?? null,
    });
    return;
  }

  for (const entry of body.entry || []) {
    const pageId = String(entry?.id || "").trim();

    console.log("[META][ENTRY_RECEIVED]", {
      pageId: pageId || null,
      messagingCount: Array.isArray(entry?.messaging)
        ? entry.messaging.length
        : 0,
    });

    if (!pageId) {
      console.warn("[META][ENTRY_WITHOUT_PAGE_ID]");
      continue;
    }

    for (const messagingEvent of entry?.messaging || []) {
      const message = messagingEvent?.message;
      const senderId = String(
        messagingEvent?.sender?.id || ""
      ).trim();

      const messageId = String(
        message?.mid || ""
      ).trim();

      const userInput =
        typeof message?.text === "string"
          ? message.text.trim()
          : "";

      console.log("[META][MESSAGING_EVENT_RECEIVED]", {
        pageId,
        senderId: senderId || null,
        messageId: messageId || null,
        hasMessage: Boolean(message),
        hasText: Boolean(userInput),
        isEcho: message?.is_echo === true,
        hasPostback: Boolean(messagingEvent?.postback),
        eventKeys:
          messagingEvent &&
          typeof messagingEvent === "object"
            ? Object.keys(messagingEvent)
            : [],
      });

      if (!senderId) {
        console.warn("[META][EVENT_WITHOUT_SENDER]", {
          pageId,
        });
        continue;
      }

      if (!messageId) {
        console.warn("[META][EVENT_WITHOUT_MESSAGE_ID]", {
          pageId,
          senderId,
        });
        continue;
      }

      if (!userInput) {
        console.warn("[META][EVENT_WITHOUT_TEXT]", {
          pageId,
          senderId,
          messageId,
        });
        continue;
      }

      if (message?.is_echo === true) {
        console.log("[META][ECHO_IGNORED]", {
          pageId,
          senderId,
          messageId,
        });
        continue;
      }

      if (senderId === pageId) {
        console.log("[META][SELF_MESSAGE_IGNORED]", {
          pageId,
          senderId,
          messageId,
        });
        continue;
      }

      console.log("[META][DISPATCHING_INBOUND]", {
        pageId,
        senderId,
        messageId,
        userInput,
      });

      void processMetaInbound({
        pageId,
        senderId,
        messageId,
        userInput,
      }).catch((error) => {
        console.error("[META][PROCESS_INBOUND_FAILED]", {
          pageId,
          senderId,
          messageId,
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                }
              : error,
        });
      });
    }
  }
});

export default router;