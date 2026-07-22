//src/routes/conversations.ts
import { Router, Request, Response } from "express";
import { authenticateUser } from "../middleware/auth";
import pool from "../lib/db";

const router = Router();

function normalizeChannel(value?: string): string {
  const channel = String(value || "")
    .trim()
    .toLowerCase();

  if (!channel) return "";

  if (
    channel.includes("whatsapp") ||
    channel.startsWith("wa")
  ) {
    return "whatsapp";
  }

  if (
    channel.includes("facebook") ||
    channel === "fb"
  ) {
    return "facebook";
  }

  if (
    channel.includes("instagram") ||
    channel === "ig"
  ) {
    return "instagram";
  }

  if (
    channel.includes("voice") ||
    channel.includes("voz") ||
    channel.includes("call") ||
    channel.includes("llamada") ||
    channel.includes("telefono")
  ) {
    return "voice";
  }

  return channel;
}

function buildChannelFilter(
  channel: string,
  parameterIndex: number
): string {
  if (!channel) {
    return "";
  }

  const parameter = `$${parameterIndex}`;

  return `
    AND (
      (${parameter} = 'whatsapp' AND (
        LOWER(COALESCE(m.canal, '')) LIKE '%whatsapp%'
        OR LOWER(COALESCE(m.canal, '')) LIKE 'wa%'
      ))
      OR
      (${parameter} = 'facebook' AND (
        LOWER(COALESCE(m.canal, '')) LIKE '%facebook%'
        OR LOWER(COALESCE(m.canal, '')) = 'fb'
      ))
      OR
      (${parameter} = 'instagram' AND (
        LOWER(COALESCE(m.canal, '')) LIKE '%instagram%'
        OR LOWER(COALESCE(m.canal, '')) = 'ig'
      ))
      OR
      (${parameter} = 'voice' AND (
        LOWER(COALESCE(m.canal, '')) LIKE '%voice%'
        OR LOWER(COALESCE(m.canal, '')) LIKE '%voz%'
        OR LOWER(COALESCE(m.canal, '')) LIKE '%call%'
        OR LOWER(COALESCE(m.canal, '')) LIKE '%llamada%'
        OR LOWER(COALESCE(m.canal, '')) LIKE '%telefono%'
      ))
      OR
      TRIM(LOWER(COALESCE(m.canal, ''))) = ${parameter}
    )
  `;
}

/**
 * GET /api/conversations
 *
 * Query:
 * - canal
 * - page
 * - limit
 * - search
 */
router.get(
  "/",
  authenticateUser,
  async (req: Request, res: Response) => {
    try {
      const tenantId = (req as any).user
        ?.tenant_id as string | undefined;

      if (!tenantId) {
        return res
          .status(401)
          .json({ error: "Tenant no autenticado" });
      }

      const channel = normalizeChannel(
        req.query.canal as string
      );

      const search = String(
        req.query.search || ""
      )
        .trim()
        .toLowerCase();

      const page = Math.max(
        Number.parseInt(
          String(req.query.page || "1"),
          10
        ) || 1,
        1
      );

      const limit = Math.min(
        Math.max(
          Number.parseInt(
            String(req.query.limit || "10"),
            10
          ) || 10,
          1
        ),
        50
      );

      const offset = (page - 1) * limit;

      const params: unknown[] = [tenantId];

      let channelSql = "";

      if (channel) {
        params.push(channel);

        channelSql = buildChannelFilter(
          channel,
          params.length
        );
      }

      let searchSql = "";

      if (search) {
        params.push(`%${search}%`);

        searchSql = `
          AND (
            LOWER(COALESCE(m.from_number, '')) LIKE $${params.length}
            OR LOWER(COALESCE(cli.nombre, '')) LIKE $${params.length}
          )
        `;
      }

      params.push(limit);
      const limitIndex = params.length;

      params.push(offset);
      const offsetIndex = params.length;

      const sql = `
        WITH source_messages AS (
          SELECT
            m.id,
            m.message_id,
            m.tenant_id,
            m.role,
            m.content,
            m.canal,
            m.from_number,
            m.timestamp,
            m.emotion,
            m.intent,
            m.interest_level,

            CASE
              WHEN LOWER(COALESCE(m.canal, '')) LIKE '%whatsapp%'
                OR LOWER(COALESCE(m.canal, '')) LIKE 'wa%'
                THEN 'whatsapp'

              WHEN LOWER(COALESCE(m.canal, '')) LIKE '%facebook%'
                OR LOWER(COALESCE(m.canal, '')) = 'fb'
                THEN 'facebook'

              WHEN LOWER(COALESCE(m.canal, '')) LIKE '%instagram%'
                OR LOWER(COALESCE(m.canal, '')) = 'ig'
                THEN 'instagram'

              WHEN LOWER(COALESCE(m.canal, '')) LIKE '%voice%'
                OR LOWER(COALESCE(m.canal, '')) LIKE '%voz%'
                OR LOWER(COALESCE(m.canal, '')) LIKE '%call%'
                OR LOWER(COALESCE(m.canal, '')) LIKE '%llamada%'
                OR LOWER(COALESCE(m.canal, '')) LIKE '%telefono%'
                THEN 'voice'

              ELSE TRIM(
                LOWER(COALESCE(m.canal, ''))
              )
            END AS canonical_channel,

            cli.nombre AS customer_name

          FROM messages m

          LEFT JOIN LATERAL (
            SELECT c.nombre
            FROM clientes c
            WHERE c.tenant_id = m.tenant_id
              AND c.contacto = m.from_number
            ORDER BY c.id DESC
            LIMIT 1
          ) cli ON true

          WHERE m.tenant_id = $1
            AND COALESCE(m.is_spam, false) = false
            ${channelSql}
            ${searchSql}
        ),

        ordered_messages AS (
          SELECT
            source_messages.*,

            LAG(timestamp) OVER (
              PARTITION BY
                canonical_channel,
                COALESCE(from_number, '')
              ORDER BY timestamp, id
            ) AS previous_timestamp

          FROM source_messages
        ),

        session_markers AS (
          SELECT
            ordered_messages.*,

            CASE
              WHEN canonical_channel = 'voice'
                THEN 0

              WHEN previous_timestamp IS NULL
                THEN 1

              WHEN timestamp - previous_timestamp
                > INTERVAL '30 minutes'
                THEN 1

              ELSE 0
            END AS starts_new_session

          FROM ordered_messages
        ),

        sessionized_messages AS (
          SELECT
            session_markers.*,

            CASE
              WHEN canonical_channel = 'voice'
                THEN SUBSTRING(
                  COALESCE(message_id, '')
                  FROM 'voice:(CA[a-zA-Z0-9]+)'
                )

              ELSE CONCAT(
                canonical_channel,
                ':',
                COALESCE(from_number, 'unknown'),
                ':',
                SUM(starts_new_session) OVER (
                  PARTITION BY
                    canonical_channel,
                    COALESCE(from_number, '')
                  ORDER BY timestamp, id
                  ROWS BETWEEN UNBOUNDED PRECEDING
                  AND CURRENT ROW
                )
              )
            END AS conversation_id

          FROM session_markers
        ),

        grouped_conversations AS (
          SELECT
            conversation_id,
            canonical_channel AS channel,
            from_number,
            MAX(customer_name) AS customer_name,
            MIN(timestamp) AS started_at,
            MAX(timestamp) AS ended_at,
            COUNT(*)::int AS message_count,

            (
              ARRAY_AGG(
                content
                ORDER BY timestamp DESC, id DESC
              )
            )[1] AS last_message,

            JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', id,
                'message_id', message_id,
                'role', role,
                'content', content,
                'timestamp', timestamp,
                'emotion', emotion,
                'intent', intent,
                'interest_level', interest_level
              )
              ORDER BY timestamp ASC, id ASC
            ) AS messages

          FROM sessionized_messages

          GROUP BY
            conversation_id,
            canonical_channel,
            from_number
        ),

        counted AS (
          SELECT
            grouped_conversations.*,
            COUNT(*) OVER ()::int AS total_conversations

          FROM grouped_conversations
        )

        SELECT
          counted.*,

          vc.duration_sec,
          vc.started_at AS call_started_at,
          vc.ended_at AS call_ended_at

        FROM counted

        LEFT JOIN voice_calls vc
          ON counted.channel = 'voice'
          AND vc.tenant_id = $1
          AND vc.call_sid = counted.conversation_id

        ORDER BY counted.ended_at DESC

        LIMIT $${limitIndex}
        OFFSET $${offsetIndex};
      `;

      const { rows } = await pool.query(
        sql,
        params
      );

      const total =
        rows.length > 0
          ? Number(rows[0].total_conversations)
          : 0;

      const conversations = rows.map(
        ({
          total_conversations,
          ...conversation
        }) => conversation
      );

      return res.json({
        ok: true,
        conversations,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(
            1,
            Math.ceil(total / limit)
          ),
        },
      });
    } catch (error) {
      console.error(
        "[CONVERSATIONS][LIST_FAILED]",
        error
      );

      return res.status(500).json({
        error: "Error al obtener conversaciones",
      });
    }
  }
);

export default router;