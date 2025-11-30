// src/routes/meta/whatsapp-callback.ts
import express, { Request, Response } from "express";
import pool from "../../lib/db";

const router = express.Router();

// Debe ser el mismo valor que pusiste en el panel de Meta (Verify Token)
const VERIFY_TOKEN =
  process.env.META_WEBHOOK_VERIFY_TOKEN || "aamy-meta-verify";

/**
 * GET /api/meta/whatsapp/callback
 *
 * Verificación del webhook (hub.challenge)
 */
router.get("/whatsapp/callback", (req: Request, res: Response) => {
  try {
    console.log("🌐 [META WEBHOOK] GET verificación:", req.query);

    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ [META WEBHOOK] Verificación OK");
      return res.status(200).send(challenge as string);
    }

    console.warn("⚠️ [META WEBHOOK] Verificación fallida", {
      mode,
      token,
      expected: VERIFY_TOKEN,
    });
    return res.sendStatus(403);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error en verificación:", err);
    return res.sendStatus(500);
  }
});

/**
 * POST /api/meta/whatsapp/callback
 *
 * Aquí llegan TODOS los eventos de mensajes de WhatsApp Cloud API.
 */
router.post("/whatsapp/callback", async (req: Request, res: Response) => {
  try {
    console.log(
      "📩 [META WEBHOOK] Evento recibido:",
      JSON.stringify(req.body, null, 2)
    );

    // 1️⃣ Extraer datos básicos del evento
    const entry = req.body?.entry?.[0]?.changes?.[0]?.value;
    const messages = entry?.messages;

    // Puede ser solo un "status" de mensaje enviado, no un mensaje entrante
    if (!messages || !messages.length) {
      return res.sendStatus(200);
    }

    const msg = messages[0];

    const from = msg.from as string | undefined; // número del cliente
    const body = msg.text?.body as string | undefined;
    const phoneNumberId = entry?.metadata?.phone_number_id as
      | string
      | undefined;

    console.log("[META WEBHOOK] Parsed:", { from, body, phoneNumberId });

    if (!from || !phoneNumberId) {
      console.warn(
        "[META WEBHOOK] Falta from o phoneNumberId, no se puede responder."
      );
      return res.sendStatus(200);
    }

        // 2️⃣ Buscar tenant por phone_number_id en tu DB
    let tenantRow: any | null = null;

    try {
      const { rows } = await pool.query(
        `
        SELECT
          id,
          name,
          mensaje_bienvenida,
          prompt,
          funciones_asistente,
          info_clave,
          idioma,
          categoria
        FROM tenants
        WHERE whatsapp_phone_number_id = $1
        LIMIT 1
      `,
        [phoneNumberId]
      );

      tenantRow = rows[0] || null;
      console.log("[META WEBHOOK] Tenant encontrado:", tenantRow?.id);
    } catch (dbErr) {
      console.error("❌ [META WEBHOOK] Error buscando tenant:", dbErr);
    }

        if (!tenantRow) {
      console.warn(
        "[META WEBHOOK] No se encontró tenant para phone_number_id:",
        phoneNumberId
      );
      // Aun así respondemos algo genérico para que el test funcione
      return await enviarRespuestaMeta({
        to: from,
        phoneNumberId,
        text:
          body && body.trim().length > 0
            ? `Hola 👋, recibí tu mensaje: "${body}". Aún no encuentro el negocio asociado a este número en Aamy.`
            : "Hola 👋, soy Aamy. Recibí tu mensaje, pero aún no encuentro el negocio asociado a este número.",
      });
    }

    // 3️⃣ Construir la respuesta usando la info del tenant
    const nombreNegocio: string = tenantRow.name || "tu negocio";
    const mensajeBienvenida: string | null = tenantRow.mensaje_bienvenida;
    const funcionesAsistente: string | null = tenantRow.funciones_asistente;
    const infoClave: string | null = tenantRow.info_clave;

    let replyText: string;

    const textoUsuario = (body || "").trim().toLowerCase();

    // Caso 1: primer contacto tipo "hola" → usar bienvenida directa si existe
    if (mensajeBienvenida && (textoUsuario === "hola" || textoUsuario === "buenas" || textoUsuario === "hi")) {
      replyText = mensajeBienvenida;
    } else if (body && body.trim().length > 0) {
      // Caso 2: ya hizo una pregunta o escribió algo concreto
      replyText = `Hola 👋, soy Aamy, asistente de ${nombreNegocio}.

Recibí tu mensaje: "${body}".

Puedo ayudarte con:
${funcionesAsistente || "- Consultas generales\n- Horarios\n- Reservas y servicios"}

Información clave del negocio:
${infoClave || "Servicios, precios y políticas principales que has configurado en tu panel de Aamy."}
`;
    } else {
      // Caso 3: mensaje vacío o raro
      replyText = `Hola 👋, soy Aamy, asistente de ${nombreNegocio}. ¿En qué puedo ayudarte hoy?

Puedo orientarte sobre:
${funcionesAsistente || "- Servicios\n- Precios\n- Horarios\n- Reservas"}
`;
    }

    // 4️⃣ Enviar mensaje usando WhatsApp Cloud API
    await enviarRespuestaMeta({
      to: from,
      phoneNumberId,
      text: replyText,
    });

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ [META WEBHOOK] Error procesando evento:", err);
    return res.sendStatus(500);
  }
});

// Función helper para enviar mensaje por Meta
async function enviarRespuestaMeta(params: {
  to: string;
  phoneNumberId: string;
  text: string;
}) {
  const { to, phoneNumberId, text } = params;

  const token = process.env.META_WA_ACCESS_TOKEN;
  if (!token) {
    console.error(
      "❌ [META WEBHOOK] Falta META_WA_ACCESS_TOKEN para enviar mensajes."
    );
    return;
  }

  const url = `https://graph.facebook.com/v18.0/${encodeURIComponent(
    phoneNumberId
  )}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      preview_url: false,
      body: text,
    },
  };

  console.log("[META WEBHOOK] Enviando respuesta a WhatsApp:", {
    url,
    payload,
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const respJson = await resp.json();
  console.log(
    "📤 [META WEBHOOK] Respuesta de envío de mensaje:",
    resp.status,
    respJson
  );
}

export default router;