// src/lib/crm/resolveMessagingContact.ts

import type { Pool, PoolClient } from "pg";

export type MessagingChannel =
  | "whatsapp"
  | "instagram"
  | "facebook";

type ResolveMessagingContactParams = {
  pool: Pool;
  tenantId: string;
  channel: MessagingChannel;
  channelContactId: string;
  phone?: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizePhoneForChannel(
  channel: MessagingChannel,
  phone: unknown
): string | null {
  if (channel !== "whatsapp") {
    return null;
  }

  const value = clean(phone);
  return value || null;
}

async function updateExistingContactActivity(params: {
  client: PoolClient;
  tenantId: string;
  contactId: number;
  channel: MessagingChannel;
}): Promise<void> {
  await params.client.query(
    `
    UPDATE contactos
    SET
      ultimo_canal = $3,
      origen = COALESCE(NULLIF(origen, ''), $3),
      ultima_interaccion_at = NOW(),
      updated_at = NOW()
    WHERE id = $1
      AND tenant_id = $2
    `,
    [
      params.contactId,
      params.tenantId,
      params.channel,
    ]
  );
}

/**
 * Resuelve el contacto CRM correspondiente a una identidad de mensajería.
 *
 * clientes:
 * - conserva la identidad propia del canal;
 * - conserva el estado conversacional;
 * - apunta a contactos mediante contacto_id.
 *
 * contactos:
 * - representa a la persona en el CRM;
 * - solo guarda teléfono cuando es un teléfono real;
 * - nunca guarda IDs de Instagram/Facebook como teléfono.
 */
export async function resolveMessagingContact(
  params: ResolveMessagingContactParams
): Promise<number | null> {
  const tenantId = clean(params.tenantId);
  const channel = clean(params.channel).toLowerCase() as MessagingChannel;
  const channelContactId = clean(params.channelContactId);

  if (
    !tenantId ||
    !channelContactId ||
    !["whatsapp", "instagram", "facebook"].includes(channel)
  ) {
    console.warn("[CONTACTOS][MESSAGING_RESOLUTION_SKIPPED]", {
      tenantId,
      channel,
      channelContactId,
      reason: "INVALID_REQUIRED_FIELDS",
    });

    return null;
  }

  const phone = normalizePhoneForChannel(channel, params.phone);
  const client = await params.pool.connect();

  try {
    await client.query("BEGIN");

    /*
     * ensureClienteBase() debe ejecutarse antes de esta función.
     * Bloqueamos la identidad del canal para evitar crear dos contactos
     * si llegan dos mensajes simultáneamente.
     */
    const clientIdentityResult = await client.query(
      `
      SELECT contacto_id
      FROM clientes
      WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
      LIMIT 1
      FOR UPDATE
      `,
      [
        tenantId,
        channel,
        channelContactId,
      ]
    );

    if (clientIdentityResult.rows.length === 0) {
      await client.query("ROLLBACK");

      console.warn("[CONTACTOS][MESSAGING_IDENTITY_NOT_FOUND]", {
        tenantId,
        channel,
        channelContactId,
      });

      return null;
    }

    const linkedContactIdRaw =
      clientIdentityResult.rows[0]?.contacto_id;

    const linkedContactId =
      linkedContactIdRaw == null
        ? null
        : Number(linkedContactIdRaw);

    /*
     * Si la identidad ya está enlazada, solamente actualizamos
     * la actividad del contacto existente.
     */
    if (
      linkedContactId !== null &&
      Number.isInteger(linkedContactId) &&
      linkedContactId > 0
    ) {
      await updateExistingContactActivity({
        client,
        tenantId,
        contactId: linkedContactId,
        channel,
      });

      await client.query("COMMIT");

      console.log("[CONTACTOS][MESSAGING_CONTACT_REUSED]", {
        tenantId,
        channel,
        channelContactId,
        contactId: linkedContactId,
      });

      return linkedContactId;
    }

    let contactId: number | null = null;

    /*
     * WhatsApp entrega un teléfono real.
     * Primero intentamos reutilizar un contacto creado anteriormente
     * por Voice o por otra interacción de WhatsApp.
     */
    if (channel === "whatsapp" && phone) {
      const existingPhoneContactResult = await client.query(
        `
        SELECT id
        FROM contactos
        WHERE tenant_id = $1
          AND telefono = $2
        LIMIT 1
        FOR UPDATE
        `,
        [
          tenantId,
          phone,
        ]
      );

      const existingPhoneContactId =
        existingPhoneContactResult.rows[0]?.id;

      if (existingPhoneContactId != null) {
        contactId = Number(existingPhoneContactId);

        await updateExistingContactActivity({
          client,
          tenantId,
          contactId,
          channel,
        });
      } else {
        /*
         * Sigue el mismo patrón del CRM de Voice:
         * contacto lead, teléfono real, origen y último canal.
         */
        const insertedContactResult = await client.query(
          `
          INSERT INTO contactos (
            tenant_id,
            telefono,
            segmento,
            fecha_creacion,
            origen,
            ultimo_canal,
            ultima_interaccion_at,
            updated_at
          )
          VALUES (
            $1,
            $2,
            'lead',
            NOW(),
            $3,
            $3,
            NOW(),
            NOW()
          )
          ON CONFLICT (tenant_id, telefono)
          DO UPDATE SET
            ultimo_canal = EXCLUDED.ultimo_canal,
            origen = COALESCE(
              NULLIF(contactos.origen, ''),
              EXCLUDED.origen
            ),
            ultima_interaccion_at = NOW(),
            updated_at = NOW()
          RETURNING id
          `,
          [
            tenantId,
            phone,
            channel,
          ]
        );

        contactId = Number(
          insertedContactResult.rows[0]?.id
        );
      }
    } else {
      /*
       * Instagram y Facebook no entregan teléfono.
       * Creamos el contacto CRM sin inventar datos.
       *
       * La identidad de Meta permanece en:
       * clientes.tenant_id + clientes.canal + clientes.contacto
       */
      const insertedContactResult = await client.query(
        `
        INSERT INTO contactos (
          tenant_id,
          segmento,
          fecha_creacion,
          origen,
          ultimo_canal,
          ultima_interaccion_at,
          updated_at
        )
        VALUES (
          $1,
          'lead',
          NOW(),
          $2,
          $2,
          NOW(),
          NOW()
        )
        RETURNING id
        `,
        [
          tenantId,
          channel,
        ]
      );

      contactId = Number(
        insertedContactResult.rows[0]?.id
      );
    }

    if (
      !Number.isInteger(contactId) ||
      Number(contactId) <= 0
    ) {
      throw new Error(
        "No se pudo resolver un contacto CRM válido"
      );
    }

    await client.query(
      `
      UPDATE clientes
      SET
        contacto_id = $4,
        updated_at = NOW()
      WHERE tenant_id = $1
        AND canal = $2
        AND contacto = $3
      `,
      [
        tenantId,
        channel,
        channelContactId,
        contactId,
      ]
    );

    await client.query("COMMIT");

    console.log("[CONTACTOS][MESSAGING_CONTACT_LINKED]", {
      tenantId,
      channel,
      channelContactId,
      phone,
      contactId,
    });

    return contactId;
  } catch (error) {
    await client.query("ROLLBACK");

    console.error("[CONTACTOS][MESSAGING_RESOLUTION_ERROR]", {
      tenantId,
      channel,
      channelContactId,
      phone,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    });

    /*
     * El CRM no debe impedir que Aamy responda el mensaje.
     */
    return null;
  } finally {
    client.release();
  }
}