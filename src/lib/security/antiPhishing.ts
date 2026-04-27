// src/lib/security/antiPhishing.ts
import type { Pool } from "pg";

export type GuardParams = {
  pool: Pool;
  tenantId: string;
  channel: string;
  senderId: string;
  messageId: string | null;
  userInput: string;

  /**
   * Se mantiene por compatibilidad con llamadas existentes.
   * Este guard ya no envía respuestas al cliente para evitar hardcode
   * de idioma, tenant o CTA.
   */
  idiomaDestino?: string | null;

  /**
   * Se mantiene por compatibilidad con llamadas existentes.
   * No se usa dentro de este guard.
   */
  send?: (text: string) => Promise<void>;
};

type SecurityRiskDecision =
  | {
      suspicious: true;
      reason: string;
      urls: string[];
      hosts: string[];
    }
  | {
      suspicious: false;
      reason: null;
      urls: string[];
      hosts: string[];
    };

function getAllowlist(): string[] {
  const extra = String(process.env.SAFE_DOMAIN_ALLOWLIST || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return Array.from(new Set(extra));
}

function trimUrlBoundaryChars(value: string): string {
  let output = String(value || "").trim();

  const openingChars = new Set(["(", "[", "{", "<", "\"", "'", "“", "‘"]);
  const closingChars = new Set([
    ")",
    "]",
    "}",
    ">",
    "\"",
    "'",
    "”",
    "’",
    ".",
    ",",
    ";",
  ]);

  while (output.length > 0 && openingChars.has(output[0])) {
    output = output.slice(1).trim();
  }

  while (output.length > 0 && closingChars.has(output[output.length - 1])) {
    output = output.slice(0, -1).trim();
  }

  return output;
}

function parseHttpUrlCandidate(value: string): URL | null {
  const cleaned = trimUrlBoundaryChars(value);

  if (!cleaned) {
    return null;
  }

  const candidates = [
    cleaned,
    cleaned.startsWith("www.") ? `https://${cleaned}` : null,
  ].filter((item): item is string => Boolean(item));

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        continue;
      }

      if (!parsed.hostname || !parsed.hostname.includes(".")) {
        continue;
      }

      return parsed;
    } catch {
      continue;
    }
  }

  return null;
}

function extractHttpUrls(text: string): string[] {
  const raw = String(text || "").trim();

  if (!raw) {
    return [];
  }

  const parts: string[] = raw
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .split(" ")
    .map((part: string) => part.trim())
    .filter((part: string) => part.length > 0);

  const urls: string[] = [];

  for (const part of parts) {
    const parsed = parseHttpUrlCandidate(part);

    if (!parsed) {
      continue;
    }

    urls.push(parsed.toString());
  }

  return Array.from(new Set(urls));
}

function hostFromUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const host = String(parsed.hostname || "")
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");

    return host || null;
  } catch {
    return null;
  }
}

function isAllowedHost(host: string, allowlist: string[]): boolean {
  const normalizedHost = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");

  if (!normalizedHost) {
    return false;
  }

  return allowlist.some((allowed) => {
    const normalizedAllowed = String(allowed || "")
      .trim()
      .toLowerCase()
      .replace(/^www\./, "");

    if (!normalizedAllowed) {
      return false;
    }

    return (
      normalizedHost === normalizedAllowed ||
      normalizedHost.endsWith(`.${normalizedAllowed}`)
    );
  });
}

/**
 * Este guard ya no intenta interpretar texto con regex ni frases fijas.
 *
 * Responsabilidad:
 * - registrar y cortar enlaces HTTP externos no allowlisted si llegan hasta aquí.
 *
 * Nota:
 * - Los links externos normales del usuario deben ser manejados antes por
 *   userExternalLinkGuard.
 * - antiPhishing queda como segunda capa defensiva/log-only.
 */
function analyzeSecurityRisk(text: string): SecurityRiskDecision {
  const urls = extractHttpUrls(text);
  const hosts = urls
    .map((url) => hostFromUrl(url))
    .filter((host): host is string => Boolean(host));

  if (!urls.length) {
    return {
      suspicious: false,
      reason: null,
      urls,
      hosts,
    };
  }

  const allowlist = getAllowlist();

  if (!allowlist.length) {
    return {
      suspicious: true,
      reason: "external_link_without_allowlist",
      urls,
      hosts,
    };
  }

  const hasUntrustedHost = hosts.some((host) => !isAllowedHost(host, allowlist));

  if (hasUntrustedHost) {
    return {
      suspicious: true,
      reason: "external_link_untrusted_domain",
      urls,
      hosts,
    };
  }

  return {
    suspicious: false,
    reason: null,
    urls,
    hosts,
  };
}

async function isSenderBlocked(
  pool: Pool,
  tenantId: string,
  channelUserId: string
): Promise<boolean> {
  if ((process.env.ANTI_PHISHING_MODE || "review").toLowerCase() === "review") {
    return false;
  }

  const q = await pool.query(
    `
    SELECT 1
    FROM blocked_senders
    WHERE tenant_id = $1
      AND channel_user_id = $2
    LIMIT 1
    `,
    [tenantId, channelUserId]
  );

  return q.rows.length > 0;
}

export async function blockSender(
  pool: Pool,
  tenantId: string,
  channelUserId: string,
  reason: string,
  channel: string = "whatsapp"
): Promise<boolean> {
  try {
    await pool.query(
      `
      INSERT INTO spam_reports (
        tenant_id,
        channel,
        channel_user_id,
        text,
        reason
      )
      VALUES ($1, $2, $3, '', $4)
      ON CONFLICT DO NOTHING
      `,
      [tenantId, channel, channelUserId, reason]
    );

    console.log("[antiPhishing][BLOCK_SENDER_REVIEW]", {
      tenantId,
      channel,
      channelUserId,
      reason,
    });
  } catch (err) {
    console.warn("[antiPhishing][BLOCK_SENDER_REVIEW_FAILED]", err);
  }

  return false;
}

async function recordSpam(params: {
  pool: Pool;
  tenantId: string;
  channel: string;
  channelUserId: string;
  text: string;
  reason: string;
  hosts: string[];
}): Promise<void> {
  await params.pool.query(
    `
    INSERT INTO spam_reports (
      tenant_id,
      channel,
      channel_user_id,
      text,
      reason
    )
    VALUES ($1, $2, $3, $4, $5)
    `,
    [
      params.tenantId,
      params.channel,
      params.channelUserId,
      String(params.text || "").slice(0, 4000),
      [
        params.reason,
        params.hosts.length ? `hosts:${params.hosts.join(",")}` : null,
      ]
        .filter(Boolean)
        .join("|"),
    ]
  );
}

async function markUserMessageAsSpam(params: {
  pool: Pool;
  tenantId: string;
  channel: string;
  senderId: string;
  messageId: string | null;
  userInput: string;
  reason: string;
}): Promise<void> {
  try {
    await params.pool.query(
      `
      INSERT INTO messages (
        tenant_id,
        role,
        content,
        timestamp,
        canal,
        from_number,
        message_id,
        is_spam,
        spam_reason
      )
      VALUES ($1, 'user', $2, NOW(), $3, $4, $5, true, $6)
      ON CONFLICT (tenant_id, message_id) DO NOTHING
      `,
      [
        params.tenantId,
        params.userInput,
        params.channel,
        params.senderId || "anónimo",
        params.messageId,
        params.reason,
      ]
    );
  } catch (err) {
    console.warn("[antiPhishing][MARK_MESSAGE_AS_SPAM_FAILED]", {
      tenantId: params.tenantId,
      channel: params.channel,
      senderId: params.senderId,
      messageId: params.messageId,
      reason: params.reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Guard anti-phishing reutilizable.
 *
 * Devuelve true si el mensaje debe cortarse por seguridad.
 *
 * Importante:
 * - No envía respuesta al cliente.
 * - No hardcodea idioma.
 * - No hardcodea dominio oficial del tenant.
 * - No reemplaza a userExternalLinkGuard.
 */
export async function antiPhishingGuard(p: GuardParams): Promise<boolean> {
  if (await isSenderBlocked(p.pool, p.tenantId, p.senderId)) {
    console.log("[antiPhishing][SENDER_ALREADY_BLOCKED]", {
      tenantId: p.tenantId,
      channel: p.channel,
      senderId: p.senderId,
    });

    return true;
  }

  const decision = analyzeSecurityRisk(p.userInput || "");

  if (!decision.suspicious) {
    return false;
  }

  await recordSpam({
    pool: p.pool,
    tenantId: p.tenantId,
    channel: p.channel,
    channelUserId: p.senderId,
    text: p.userInput || "",
    reason: decision.reason,
    hosts: decision.hosts,
  });

  await markUserMessageAsSpam({
    pool: p.pool,
    tenantId: p.tenantId,
    channel: p.channel,
    senderId: p.senderId,
    messageId: p.messageId,
    userInput: p.userInput || "",
    reason: decision.reason,
  });

  const autoBlock =
    String(process.env.SPAM_AUTOBLOCK || "true").toLowerCase() === "true";

  if (autoBlock && decision.urls.length) {
    await blockSender(
      p.pool,
      p.tenantId,
      p.senderId,
      decision.reason,
      p.channel
    );
  }

  console.log("[antiPhishing][MESSAGE_BLOCKED]", {
    tenantId: p.tenantId,
    channel: p.channel,
    senderId: p.senderId,
    reason: decision.reason,
    hosts: decision.hosts,
    urlsCount: decision.urls.length,
  });

  return true;
}