// backend/src/lib/awaiting.ts
import pool from "./db";

export type AwaitingStateRow = {
  awaiting_field: string | null;
  awaiting_payload: any | null;
  awaiting_updated_at: Date | null;
};

const AWAITING_TTL_MIN = 45;

function isExpired(dt: Date | null) {
  if (!dt) return true;
  const ageMs = Date.now() - new Date(dt).getTime();
  return ageMs > AWAITING_TTL_MIN * 60 * 1000;
}

export function normalizeContacto(canal: string, raw: string) {
  let s = String(raw || "").trim();

  // Twilio WhatsApp suele venir como "whatsapp:+1775..."
  if (s.startsWith("whatsapp:")) s = s.replace("whatsapp:", "");

  // WhatsApp: queremos E.164 con "+"
  if (canal === "whatsapp") {
    // deja solo dígitos, pero conserva el + al frente
    const digits = s.replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }

  // Meta: normalmente es PSID, no tocarlo
  return s;
}

export async function getAwaitingState(

  tenantId: string,
  canal: string,
  contacto: string
): Promise<AwaitingStateRow | null> {

  const contactoKey = normalizeContacto(canal, contacto);

  const { rows } = await pool.query(
    `
    SELECT awaiting_field, awaiting_payload, awaiting_updated_at
    FROM clientes
    WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
    LIMIT 1
    `,
    [tenantId, canal, contactoKey]
  );

  const row: AwaitingStateRow | undefined = rows[0];
  if (!row?.awaiting_field) return null;

  // TTL: si expiró, lo limpiamos y devolvemos null
  if (isExpired(row.awaiting_updated_at ? new Date(row.awaiting_updated_at) : null)) {
    await pool.query(
      `
      UPDATE clientes
      SET awaiting_field = NULL,
          awaiting_payload = '{}'::jsonb,
          awaiting_updated_at = NULL,
          updated_at = NOW()
      WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
      `,
      [tenantId, canal, contactoKey]
    );
    return null;
  }

  return row;
}

export async function setAwaitingState(
  tenantId: string,
  canal: string,
  contacto: string,
  awaitingField: string,
  awaitingPayload: any
) {

  const contactoKey = normalizeContacto(canal, contacto);

  await pool.query(
    `
    INSERT INTO clientes (tenant_id, canal, contacto, awaiting_field, awaiting_payload, awaiting_updated_at, updated_at)
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW(), NOW())
    ON CONFLICT (tenant_id, canal, contacto)
    DO UPDATE SET
      awaiting_field = EXCLUDED.awaiting_field,
      awaiting_payload = EXCLUDED.awaiting_payload,
      awaiting_updated_at = NOW(),
      updated_at = NOW()
    `,
    [tenantId, canal, contactoKey, awaitingField, JSON.stringify(awaitingPayload ?? {})]
  );
}

export async function clearAwaitingState(
  tenantId: string,
  canal: string,
  contacto: string
) {
  const contactoKey = normalizeContacto(canal, contacto);

  await pool.query(
    `
    UPDATE clientes
    SET awaiting_field = NULL,
        awaiting_payload = '{}'::jsonb,
        awaiting_updated_at = NULL,
        updated_at = NOW()
    WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
    `,
    [tenantId, canal, contactoKey]
  );
}

function norm(s: string) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function looksLikeGeneralQuestion(t: string) {
  const x = norm(t);
  return (
    x.includes("info") ||
    x.includes("informacion") ||
    x.includes("como funciona") ||
    x.includes("como es") ||
    x.includes("precio") ||
    x.includes("costo") ||
    x.includes("cuanto") ||
    x.includes("planes") ||
    x.includes("quiero saber") ||
    x.includes("dime mas") ||
    x.includes("me interesa") ||
    x === "hola" ||
    x === "hello"
  );
}

export function validateAwaitingInput(params: {
  awaitingField: string;
  userText: string;
  awaitingPayload?: any;
}):
  | { ok: true; value: any }
  | { ok: false; reason: "no_match" | "escape" } {
  const { awaitingField, userText, awaitingPayload } = params;
  const t = norm(userText);

  // Escape universal: si el usuario hace una pregunta general,
  // NO lo forces a contestar el wizard.
  if (looksLikeGeneralQuestion(t)) {
    return { ok: false, reason: "escape" };
  }

  switch (awaitingField) {
    case "canal_a_automatizar":
    case "canal":
    case "select_channel": {
    const allowed: string[] = Array.isArray(awaitingPayload?.allowed)
        ? awaitingPayload.allowed
        : ["whatsapp", "instagram", "facebook"];

    const map: Record<string, string> = {
        wa: "whatsapp",
        whats: "whatsapp",
        whatsapp: "whatsapp",
        ig: "instagram",
        insta: "instagram",
        instagram: "instagram",
        fb: "facebook",
        face: "facebook",
        facebook: "facebook",
    };

    let pick: string | null = null;
    for (const k of Object.keys(map)) {
        if (t.includes(k)) {
        pick = map[k];
        break;
        }
    }

    if (!pick) return { ok: false, reason: "no_match" };
    if (!allowed.includes(pick)) return { ok: false, reason: "no_match" };

    return { ok: true, value: pick };
    }

    case "select_language": {
      const allowed: string[] = Array.isArray(awaitingPayload?.allowed)
        ? awaitingPayload.allowed
        : ["es", "en"];

      const pick =
        t.includes("es") || t.includes("espanol") || t.includes("español")
          ? "es"
          : t.includes("en") || t.includes("ingles") || t.includes("inglés")
          ? "en"
          : null;

      if (!pick) return { ok: false, reason: "no_match" };
      if (!allowed.includes(pick)) return { ok: false, reason: "no_match" };

      return { ok: true, value: pick };
    }

    // Para “collect_*”: normalmente aceptas cualquier texto no vacío,
    // pero igual puedes escapar si viene otra cosa rara.
    case "collect_business_name":
    case "collect_services":
    case "collect_hours":
    case "collect_booking_link":
    case "collect_contact_email":
    case "select_business_category": {
      if (!t) return { ok: false, reason: "no_match" };
      return { ok: true, value: userText.trim() };
    }

    case "confirm_payment": {
      // ejemplo: si esperas "listo/pagué/sí" o "no"
      if (["si", "sí", "pague", "pagué", "listo", "hecho", "done", "yes"].some(w => t.includes(w))) {
        return { ok: true, value: true };
      }
      if (["no", "aun no", "todavia no", "not yet"].some(w => t.includes(w))) {
        return { ok: true, value: false };
      }
      return { ok: false, reason: "no_match" };
    }

    case "handoff_to_human_reason": {
      if (!t) return { ok: false, reason: "no_match" };
      return { ok: true, value: userText.trim() };
    }

    default:
      // Si no reconocemos el campo, mejor escapar para no trabar la conversación
      return { ok: false, reason: "escape" };
  }
}
