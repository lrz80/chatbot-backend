// src/lib/security/antiPhishing.ts
import type { Pool } from "pg";
import { normalizeLangCode, type LangCode } from "../i18n/lang";

export type GuardParams = {
  pool: Pool;
  tenantId: string;
  channel: string;
  senderId: string;
  messageId: string | null;
  userInput: string;
  idiomaDestino?: LangCode;
  send: (text: string) => Promise<void>;
};

const DEFAULT_ALLOWLIST = [
  "facebook.com",
  "fb.com",
  "instagram.com",
  "meta.com",
  "aamy.ai",
];

const SECURITY_MESSAGES: Record<string, string> = {
  es: "Por motivos de seguridad no abrimos enlaces externos ni gestionamos verificaciones por chat. Si necesitas ayuda, visita nuestro sitio oficial: https://www.aamy.ai",
  en: "For security reasons, we don’t open external links or process verification requests via chat. If you need help, please visit our official site: https://www.aamy.ai",
};

function getAllowlist(): string[] {
  const extra = (process.env.SAFE_DOMAIN_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return [...new Set([...DEFAULT_ALLOWLIST, ...extra])];
}

function extractUrls(text: string): string[] {
  const re = /(https?:\/\/[^\s]+)/gi;
  return [...(text?.match?.(re) ?? [])].map((u) => u.trim());
}

function domainFromUrl(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function looksPhishy(text: string): { suspicious: boolean; reason: string } {
  const urls = extractUrls(text);

  const badPhrases = [
    /verify|verification|confirm|appeal|suspend|suspended|disabled/i,
    /copyright|community standards|violation/i,
    /24\s*hours|within\s*24/i,
    /meta support|security team|check manager/i,
  ];

  if (badPhrases.some((rx) => rx.test(text))) {
    return { suspicious: true, reason: "phishing_keywords" };
  }

  if (urls.length) {
    const allow = getAllowlist();

    for (const u of urls) {
      const d = domainFromUrl(u);
      if (!d) continue;

      const ok = allow.some((aw) => d === aw || d.endsWith("." + aw));
      if (!ok) {
        return { suspicious: true, reason: `untrusted_domain:${d}` };
      }
    }
  }

  return { suspicious: false, reason: "" };
}

function getSecurityReply(lang?: string | null): string {
  const normalized = normalizeLangCode(lang) ?? "es";
  return SECURITY_MESSAGES[normalized] || SECURITY_MESSAGES.es;
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
    `SELECT 1
       FROM blocked_senders
      WHERE tenant_id = $1 AND channel_user_id = $2
      LIMIT 1`,
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
      `INSERT INTO spam_reports (tenant_id, channel, channel_user_id, text, reason)
       VALUES ($1, $2, $3, '', $4)
       ON CONFLICT DO NOTHING`,
      [tenantId, channel, channelUserId, reason]
    );

    console.log(
      `⚠️ [antiPhishing] Registro pasivo: ${channelUserId} (${reason}) canal=${channel}`
    );
  } catch (err) {
    console.warn("No se pudo registrar evento de spam:", err);
  }

  return false;
}

async function recordSpam(
  pool: Pool,
  tenantId: string,
  channel: string,
  channelUserId: string,
  text: string,
  reason: string
): Promise<void> {
  await pool.query(
    `INSERT INTO spam_reports (tenant_id, channel, channel_user_id, text, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, channel, channelUserId, text?.slice(0, 4000) ?? "", reason]
  );
}

/**
 * Guard anti-phishing reutilizable.
 * Devuelve true si ya manejó el mensaje.
 */
export async function antiPhishingGuard(p: GuardParams): Promise<boolean> {
  if (await isSenderBlocked(p.pool, p.tenantId, p.senderId)) {
    return true;
  }

  const { suspicious, reason } = looksPhishy(p.userInput || "");
  if (!suspicious) return false;

  await recordSpam(
    p.pool,
    p.tenantId,
    p.channel,
    p.senderId,
    p.userInput || "",
    reason
  );

  try {
    await p.pool.query(
      `INSERT INTO messages (
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
       ON CONFLICT (tenant_id, message_id) DO NOTHING`,
      [
        p.tenantId,
        p.userInput,
        p.channel,
        p.senderId || "anónimo",
        p.messageId,
        reason,
      ]
    );
  } catch {}

  await p.send(getSecurityReply(p.idiomaDestino));

  const urls = extractUrls(p.userInput || "");
  const autoBlock = (process.env.SPAM_AUTOBLOCK || "true").toLowerCase() === "true";

  if (autoBlock && urls.length) {
    await blockSender(p.pool, p.tenantId, p.senderId, reason, p.channel);
  }

  return true;
}