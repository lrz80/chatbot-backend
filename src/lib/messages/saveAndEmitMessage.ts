//src/lib/messages/saveAndEmitMessage.ts
import pool from "../db";
import { getIO } from "../socket";

export type MessageRole = "user" | "assistant" | "system";

type SaveAndEmitMessageParams = {
  tenantId: string | null;
  messageId: string;
  content: string;
  role: MessageRole;
  canal: string;
  fromNumber?: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function saveAndEmitMessage(params: SaveAndEmitMessageParams) {
  const tenantId = clean(params.tenantId);
  const messageId = clean(params.messageId);
  const content = clean(params.content);
  const role = clean(params.role);
  const canal = clean(params.canal) || "voice";
  const fromNumber = clean(params.fromNumber) || null;

  if (!tenantId || !messageId || !content || !role) {
    return null;
  }

  const { rows } = await pool.query(
    `
    INSERT INTO messages (
      message_id,
      tenant_id,
      content,
      role,
      canal,
      timestamp,
      from_number
    )
    VALUES ($1, $2, $3, $4, $5, NOW(), $6)
    RETURNING
      id,
      message_id,
      tenant_id,
      content,
      role,
      canal,
      timestamp,
      from_number
    `,
    [messageId, tenantId, content, role, canal, fromNumber]
  );

  const savedMessage = rows[0];

  try {
    const io = getIO();

    io.emit("message:new", savedMessage);
  } catch (error) {
    console.error("[MESSAGES][SOCKET_EMIT_ERROR]", {
      tenantId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return savedMessage;
}

export async function updateAndEmitMessageByMessageId(params: {
  tenantId: string | null;
  messageId: string;
  content: string;
}) {
  const tenantId = clean(params.tenantId);
  const messageId = clean(params.messageId);
  const content = clean(params.content);

  if (!tenantId || !messageId || !content) {
    return null;
  }

  const { rows } = await pool.query(
    `
    UPDATE messages
    SET content = $3
    WHERE tenant_id = $1
      AND message_id = $2
    RETURNING
      id,
      message_id,
      tenant_id,
      content,
      role,
      canal,
      timestamp,
      from_number
    `,
    [tenantId, messageId, content]
  );

  const updatedMessage = rows[0];

  if (!updatedMessage) {
    return null;
  }

  try {
    const io = getIO();
    io.emit("message:update", updatedMessage);
  } catch (error) {
    console.error("[MESSAGES][SOCKET_UPDATE_EMIT_ERROR]", {
      tenantId,
      messageId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return updatedMessage;
}