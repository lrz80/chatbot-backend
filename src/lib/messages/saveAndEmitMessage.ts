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