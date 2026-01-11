// backend/src/lib/guards/awaitingFieldGate.ts
import type { Pool } from "pg";

type Idioma = "es" | "en";

type AwaitingField =
  | "name"
  | "email"
  | "phone"
  | "channel"
  | "code"
  | "custom";

export type AwaitingFieldGateResult =
  | { action: "continue" }
  | { action: "silence"; reason: "awaiting_field_but_empty" }
  | {
      action: "reply";
      replySource:
        | "awaitingfield-invalid"
        | "awaitingfield-handled"
        | "awaitingfield-captured-no-next";
      intent: "awaiting_field";
      facts: Record<string, any>;
      transition?: { patchCliente?: Record<string, any> };
    }
  | { action: "transition"; transition: { patchCliente?: Record<string, any> } };

function norm(s: string) {
  return (s || "").trim();
}
function normLower(s: string) {
  return norm(s).toLowerCase();
}

function extractEmail(text: string): string | null {
  const m = (text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

function extractPhone(text: string): string | null {
  const digits = (text || "").replace(/[^\d+]/g, "");
  const onlyNums = digits.replace(/[^\d]/g, "");
  if (onlyNums.length < 10) return null;
  return digits.startsWith("+") ? `+${onlyNums}` : onlyNums;
}

function extractName(text: string): string | null {
  const t = norm(text);
  if (!t) return null;
  if (extractEmail(t)) return null;
  if (extractPhone(t)) return null;
  if (t.length > 60) return null;
  return t.replace(/^(mi nombre es|me llamo|soy)\s+/i, "").trim() || null;
}

function extractChannel(text: string): "whatsapp" | "instagram" | "facebook" | null {
  const t = normLower(text);
  if (!t) return null;
  if (/\b(wa|whatsapp)\b/.test(t)) return "whatsapp";
  if (/\b(insta|instagram)\b/.test(t)) return "instagram";
  if (/\b(fb|face|facebook)\b/.test(t)) return "facebook";
  return null;
}

/**
 * Awaiting Field Gate (decision-only) usando tabla clientes:
 * - Lee awaiting_field, awaiting_payload
 * - Extrae/valida el valor
 * - Actualiza columnas destino (email/telefono/nombre/selected_channel)
 * - Limpia awaiting_field/awaiting_payload
 * - Devuelve facts (sin hardcode copy)
 */
export async function awaitingFieldGate(opts: {
  pool: Pool;
  tenantId: string;
  canal: string; // "whatsapp" | "instagram" | "facebook" | etc
  contacto: string;
  userInput: string;
  idiomaDestino: Idioma;
}): Promise<AwaitingFieldGateResult> {
  const { pool, tenantId, canal, contacto, userInput, idiomaDestino } = opts;

  const input = norm(userInput);
  // 1) Leer awaiting_field/payload desde clientes
  let row: any;
  try {
    const { rows } = await pool.query(
      `SELECT awaiting_field, awaiting_payload
       FROM clientes
       WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
       LIMIT 1`,
      [tenantId, canal, contacto]
    );
    row = rows[0];
  } catch {
    return { action: "continue" };
  }

  const awaitingField: AwaitingField | string | null = row?.awaiting_field ?? null;
  const payload: any = row?.awaiting_payload ?? null;

  if (!awaitingField) return { action: "continue" };
  if (!input) return { action: "silence", reason: "awaiting_field_but_empty" };

  // 2) Extraer valor según field
  let captured: any = null;

  switch (awaitingField) {
    case "email":
      captured = extractEmail(input);
      break;
    case "phone":
      captured = extractPhone(input);
      break;
    case "name":
      captured = extractName(input);
      break;
    case "channel":
      captured = extractChannel(input);
      break;
    case "code": {
      const digits = input.replace(/[^\d]/g, "");
      captured = digits.length >= 4 ? digits : null;
      break;
    }
    case "custom":
    default:
      captured = input;
      break;
  }

  if (!captured) {
    return {
      action: "reply",
      replySource: "awaitingfield-invalid",
      intent: "awaiting_field",
      facts: {
        EVENT: "AWAITING_FIELD_INVALID",
        LANGUAGE: idiomaDestino,
        FIELD: awaitingField,
        PAYLOAD: payload,
        INSTRUCTION: "ASK_USER_FOR_VALID_VALUE_ONLY",
      },
    };
  }

  // 3) Preparar patch a clientes (sin hardcode de respuesta)
  const patch: Record<string, any> = {
    awaiting_field: null,
    awaiting_payload: null,
    awaiting_updated_at: new Date().toISOString(),
  };

  // Guardar el valor capturado en columnas nativas si aplica
  if (awaitingField === "email") patch.email = String(captured);
  if (awaitingField === "phone") patch.telefono = String(captured);
  if (awaitingField === "name") patch.nombre = String(captured);
  if (awaitingField === "channel") patch.selected_channel = String(captured);

  // También guardamos un rastro en payload si quieres
  // (no obligatorio; si no lo quieres, lo quitamos)
  patch.awaiting_updated_at = new Date().toISOString();

  // 4) Aplicar patch en DB (UPDATE con jsonb si payload fuera json; aquí son columnas)
  // Construimos dinámicamente SET para no pisar columnas innecesarias.
  const keys = Object.keys(patch);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
  const values = keys.map((k) => patch[k]);

  try {
    await pool.query(
      `UPDATE clientes
       SET ${sets}, updated_at = now()
       WHERE tenant_id = $1 AND canal = $2 AND contacto = $3`,
      [tenantId, canal, contacto, ...values]
    );
  } catch {
    // si falla update, deja seguir el pipeline normal
    return { action: "continue" };
  }

  // 5) Next declarativo: si en awaiting_payload viene next_patch (opcional)
  // Ejemplo awaiting_payload: { next_patch: { estado: "lead_captured" } }
  const nextPatch = payload?.next_patch ?? null;

  if (nextPatch && typeof nextPatch === "object") {
    return {
      action: "reply",
      replySource: "awaitingfield-handled",
      intent: "awaiting_field",
      facts: {
        EVENT: "AWAITING_FIELD_CAPTURED",
        LANGUAGE: idiomaDestino,
        FIELD: awaitingField,
        VALUE: captured,
        PAYLOAD: payload,
      },
      transition: {
        patchCliente: {
          ...nextPatch,
        },
      },
    };
  }

  return {
    action: "reply",
    replySource: "awaitingfield-captured-no-next",
    intent: "awaiting_field",
    facts: {
      EVENT: "AWAITING_FIELD_CAPTURED",
      LANGUAGE: idiomaDestino,
      FIELD: awaitingField,
      VALUE: captured,
      PAYLOAD: payload,
    },
  };
}
