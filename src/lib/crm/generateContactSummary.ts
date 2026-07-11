//src/lib/crm/generateContactSummary.ts
import pool from "../db";

type SummaryLanguage = "es" | "en";

type GenerateContactSummaryParams = {
  tenantId: string;
  contactId: number;
  language: SummaryLanguage;
};

type ContactRow = {
  id: number;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  segmento: string | null;
  estado_cliente: string | null;
  idioma: string | null;
  origen: string | null;
  ultimo_canal: string | null;
  llamadas: number | null;
  reservas: number | null;
  ultimo_servicio: string | null;
  primera_llamada: string | null;
  ultima_llamada: string | null;
  ultima_reserva_at: string | null;
  proxima_cita_at: string | null;
  valor_generado: string | number | null;
  marketing_opt_in: boolean | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeLanguage(value: unknown): SummaryLanguage {
  return clean(value).toLowerCase().startsWith("en") ? "en" : "es";
}

function truncate(value: unknown, maxLength: number): string {
  const text = clean(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

export async function generateContactSummary(
  params: GenerateContactSummaryParams
): Promise<{
  summary: string;
  generatedAt: string;
}> {
  const tenantId = clean(params.tenantId);
  const contactId = Number(params.contactId);
  const language = normalizeLanguage(params.language);

  if (!tenantId) {
    throw new Error("TENANT_ID_REQUIRED");
  }

  if (!Number.isInteger(contactId) || contactId <= 0) {
    throw new Error("INVALID_CONTACT_ID");
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY_NOT_CONFIGURED");
  }

  const contactResult = await pool.query<ContactRow>(
    `
    SELECT
      c.id,
      c.nombre,
      c.telefono,
      c.email,
      c.segmento,
      c.estado_cliente,
      c.idioma,
      c.origen,
      c.ultimo_canal,
      c.llamadas,
      c.reservas,
      c.ultimo_servicio,
      c.primera_llamada,
      c.ultima_llamada,
      c.ultima_reserva_at,
      c.proxima_cita_at,
      c.valor_generado,
      c.marketing_opt_in
    FROM contactos c
    WHERE c.id = $1
      AND c.tenant_id = $2
    LIMIT 1
    `,
    [contactId, tenantId]
  );

  const contact = contactResult.rows[0];

  if (!contact) {
    throw new Error("CONTACT_NOT_FOUND");
  }

  const phone = clean(contact.telefono);

  const appointmentsResult = phone
    ? await pool.query(
        `
        SELECT
          a.start_time,
          a.end_time,
          a.status,
          a.channel,
          a.created_at,
          s.name AS service_name
        FROM appointments a
        LEFT JOIN services s
          ON s.id = a.service_id
        WHERE a.tenant_id = $1
          AND a.customer_phone = $2
        ORDER BY a.start_time DESC
        LIMIT 30
        `,
        [tenantId, phone]
      )
    : { rows: [] as any[] };

  const messagesResult = phone
    ? await pool.query(
        `
        SELECT
          m.content,
          m.role,
          m.canal,
          m.timestamp,
          m.emotion
        FROM messages m
        WHERE m.tenant_id = $1
          AND m.from_number = $2
          AND NULLIF(BTRIM(COALESCE(m.content, '')), '') IS NOT NULL
        ORDER BY m.timestamp DESC, m.id DESC
        LIMIT 100
        `,
        [tenantId, phone]
      )
    : { rows: [] as any[] };

  /*
   * El modelo recibe datos estructurados y una cantidad limitada de historial.
   * Así evitamos prompts enormes y reducimos el riesgo de resumir información
   * que no pertenece al contacto.
   */
  const summaryInput = {
    contact: {
      name: contact.nombre,
      status: contact.estado_cliente,
      segment: contact.segmento,
      preferredLanguage: contact.idioma,
      source: contact.origen,
      lastChannel: contact.ultimo_canal,
      calls: Number(contact.llamadas || 0),
      bookings: Number(contact.reservas || 0),
      lastService: contact.ultimo_servicio,
      firstCallAt: contact.primera_llamada,
      lastCallAt: contact.ultima_llamada,
      lastBookingAt: contact.ultima_reserva_at,
      nextAppointmentAt: contact.proxima_cita_at,
      generatedValue: Number(contact.valor_generado || 0),
      marketingConsent: contact.marketing_opt_in === true,
    },

    appointments: appointmentsResult.rows.map((appointment) => ({
      service: appointment.service_name,
      startAt: appointment.start_time,
      endAt: appointment.end_time,
      status: appointment.status,
      channel: appointment.channel,
      createdAt: appointment.created_at,
    })),

    recentConversation: messagesResult.rows
      .reverse()
      .map((message) => ({
        at: message.timestamp,
        channel: message.canal,
        role: message.role,
        emotion: message.emotion,
        content: truncate(message.content, 700),
      })),
  };

  const { default: OpenAI } = await import("openai");

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const completion = await openai.chat.completions.create(
      {
        model:
          clean(process.env.OPENAI_CRM_SUMMARY_MODEL) ||
          clean(process.env.OPENAI_MODEL) ||
          "gpt-4o-mini",

        temperature: 0.1,
        max_tokens: 350,

        messages: [
          {
            role: "system",
            content:
              language === "en"
                ? [
                    "You generate concise CRM summaries for business staff.",
                    "Use only the supplied structured data.",
                    "Do not invent preferences, behavior, spending, intentions, risk, frequency, or personal details.",
                    "Do not make medical, demographic, psychological, or sensitive inferences.",
                    "Clearly distinguish confirmed facts from patterns supported by multiple records.",
                    "If there is insufficient information, say so briefly.",
                    "Write one short paragraph followed by up to four concise bullet points.",
                    "Do not include the phone number or email address.",
                    "Use professional English.",
                  ].join("\n")
                : [
                    "Generas resúmenes concisos para un CRM empresarial.",
                    "Usa exclusivamente los datos estructurados proporcionados.",
                    "No inventes preferencias, comportamiento, gastos, intenciones, riesgo, frecuencia ni datos personales.",
                    "No hagas inferencias médicas, demográficas, psicológicas ni sensibles.",
                    "Distingue claramente los hechos confirmados de los patrones respaldados por varios registros.",
                    "Si no hay suficiente información, indícalo brevemente.",
                    "Escribe un párrafo corto seguido de un máximo de cuatro puntos breves.",
                    "No incluyas el teléfono ni el correo electrónico.",
                    "Usa español profesional.",
                  ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify(summaryInput),
          },
        ],
      },
      {
        signal: controller.signal as any,
      }
    );

    const summary = clean(completion.choices[0]?.message?.content);

    if (!summary) {
      throw new Error("EMPTY_CONTACT_SUMMARY");
    }

    const updateResult = await pool.query(
      `
      UPDATE contactos
      SET
        resumen_ia = $3,
        resumen_ia_actualizado_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND tenant_id = $2
      RETURNING resumen_ia_actualizado_at
      `,
      [contactId, tenantId, summary]
    );

    const generatedAt =
      updateResult.rows[0]?.resumen_ia_actualizado_at ||
      new Date().toISOString();

    const usedTokens = Number(completion.usage?.total_tokens || 0);

    if (usedTokens > 0) {
      await pool.query(
        `
        INSERT INTO uso_mensual (
          tenant_id,
          canal,
          mes,
          usados
        )
        VALUES (
          $1,
          'tokens_openai',
          date_trunc('month', CURRENT_DATE),
          $2
        )
        ON CONFLICT (tenant_id, canal, mes)
        DO UPDATE SET
          usados = uso_mensual.usados + EXCLUDED.usados
        `,
        [tenantId, usedTokens]
      );
    }

    return {
      summary,
      generatedAt: new Date(generatedAt).toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}