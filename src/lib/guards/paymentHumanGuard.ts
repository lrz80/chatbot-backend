// backend/src/lib/guards/paymentHumanGuard.ts
import type { Pool } from "pg";
import type { Canal } from '../../lib/detectarIntencion';
import type { TurnEvent } from "../conversation/stateMachine";
import type { GateResult } from "../conversation/stateMachine";
import { setHumanOverride } from "../humanOverride/setHumanOverride";


type Idioma = "es" | "en";

const PAGO_CONFIRM_REGEX =
  /^(?!.*\b(no|aun\s*no|todav[ií]a\s*no|not)\b).*?\b(pago\s*realizado|listo\s*el\s*pago|ya\s*pagu[eé]|he\s*paga(do|do)|payment\s*(done|made|completed)|i\s*paid|paid)\b/i;

export type PaymentGuardResult =
  | { action: "continue" } // no aplica, sigue pipeline normal
  | { action: "silence"; reason: "human_override" | "pago_en_confirmacion" } // bot NO habla
  | {
      action: "reply";
      replySource:
        | "pago-link"
        | "pago-confirm"
        | "pago-datos"
        | "pago-link-missing";
      intent: "pago";
      // HECHOS para que el LLM redacte (sin hardcode)
      facts: Record<string, any>;
      // efectos ya hechos en DB (para trazabilidad)
      dbUpdated?: boolean;
      // sugerencia para tu transition()
      transition?: {
        flow?: string;
        step?: string;
        patchCtx?: any;
      };
    };

export async function paymentHumanGuard(opts: {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  contacto: string; // contactoNorm
  userInput: string;
  idiomaDestino: Idioma;

  // promptBase (SIN memoria) para extraer link si lo guardaste ahí
  promptBase: string;

  // helpers existentes (inyección para no acoplar)
  parseDatosCliente: (text: string) => null | {
    nombre?: string | null;
    email?: string | null;
    telefono?: string | null;
    pais?: string | null;
  };
  extractPaymentLinkFromPrompt: (prompt: string) => string | null;
}): Promise<PaymentGuardResult> {
  const {
    pool,
    tenantId,
    canal,
    contacto,
    userInput,
    idiomaDestino,
    promptBase,
    parseDatosCliente,
    extractPaymentLinkFromPrompt,
  } = opts;

  // 1) Leer estado cliente
  const { rows: clienteRows } = await pool.query(
    `SELECT estado, human_override, human_override_until, nombre, email, telefono, pais, segmento
     FROM clientes
     WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
     LIMIT 1`,
    [tenantId, canal, contacto]
  );

  const cliente = clienteRows[0] || null;
  const estadoActual = String(cliente?.estado || "").toLowerCase();
  const humanOverride = cliente?.human_override === true;

  const until = cliente?.human_override_until ? new Date(cliente.human_override_until) : null;
  const overrideActive = humanOverride && until && until.getTime() > Date.now();

  // 2) Silencio total SOLO si human_override está vigente (TTL)
  if (overrideActive) {
    return { action: "silence", reason: "human_override" };
  }

  // ✅ Si estaba true pero vencido, limpiamos (para no quedarse “pegado”)
  if (humanOverride && !overrideActive) {
    try {
      await pool.query(
        `UPDATE clientes
            SET human_override = false,
                human_override_until = NULL,
                updated_at = NOW()
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3`,
        [tenantId, canal, contacto]
      );
    } catch {}
  }

  // 3) Silencio total si está en confirmación de pago
  if (estadoActual === "pago_en_confirmacion") {
    return { action: "silence", reason: "pago_en_confirmacion" };
  }

  // 4) Si confirma pago → set estado + human_override (DB) y pedir respuesta por LLM (sin hardcode)
  if (PAGO_CONFIRM_REGEX.test(userInput || "")) {
    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, estado, updated_at)
      VALUES ($1, $2, $3, 'pago_en_confirmacion', now())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET estado='pago_en_confirmacion', updated_at=now()`,
      [tenantId, canal, contacto]
    );

    // ✅ activa override + notifica (TTL 5 min)
    await setHumanOverride({
      tenantId,
      canal,
      contacto,
      minutes: 5,
      reason: "pago_confirmado_por_usuario",
      source: "payment_guard",
      userMessage: userInput || null,
    });

    return {
      action: "reply",
      replySource: "pago-confirm",
      intent: "pago",
      dbUpdated: true,
      facts: {
        EVENT: "PAYMENT_CONFIRMED_BY_USER",
        LANGUAGE: idiomaDestino,
        // No copy, solo hechos:
        NEXT_STEP: "TEAM_WILL_CONFIRM_AND_ACTIVATE",
      },
      transition: {
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          guard: "payment",
          payment_status: "confirmed_by_user",
          last_bot_action: "payment_confirm_received",
        },
      },
    };
  }

  // 5) Reenvío de link si ya está esperando pago y pide link
  const LINK_REQUEST_REGEX =
    /\b(link|enlace|pagar|pago|stripe|checkout|payment\s+link)\b/i;

  if (estadoActual === "esperando_pago" && LINK_REQUEST_REGEX.test(userInput || "")) {
    const paymentLink = extractPaymentLinkFromPrompt(promptBase);

    if (!paymentLink) {
      return {
        action: "reply",
        replySource: "pago-link-missing",
        intent: "pago",
        facts: {
          EVENT: "PAYMENT_LINK_REQUESTED",
          LANGUAGE: idiomaDestino,
          PAYMENT_LINK_AVAILABLE: false,
        },
        transition: {
          flow: "generic_sales",
          step: "close",
          patchCtx: {
            guard: "payment",
            last_bot_action: "payment_link_missing",
          },
        },
      };
    }

    return {
      action: "reply",
      replySource: "pago-link",
      intent: "pago",
      facts: {
        EVENT: "PAYMENT_LINK_REQUESTED",
        LANGUAGE: idiomaDestino,
        PAYMENT_LINK_AVAILABLE: true,
        PAYMENT_LINK: paymentLink,
        INSTRUCTION: "ASK_USER_TO_TEXT_PAGO_REALIZADO_AFTER_PAYMENT",
      },
      transition: {
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          last_bot_action: "sent_payment_link",
          payment_link_sent: true,
        },
      },
    };
  }

  // 6) Si manda datos → upsert y opcionalmente responder “con link” (pero sin hardcode)
  const parsed = parseDatosCliente(userInput || "");
  if (parsed) {
    await pool.query(
      `INSERT INTO clientes (tenant_id, canal, contacto, nombre, email, telefono, pais, segmento, estado, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'lead'), 'esperando_pago', now())
       ON CONFLICT (tenant_id, canal, contacto)
       DO UPDATE SET
        nombre   = COALESCE(EXCLUDED.nombre, clientes.nombre),
        email    = COALESCE(EXCLUDED.email,  clientes.email),
        telefono = COALESCE(EXCLUDED.telefono, clientes.telefono),
        pais     = COALESCE(EXCLUDED.pais, clientes.pais),
        estado   = 'esperando_pago',
        updated_at = now()`,
      [
        tenantId,
        canal,
        contacto,
        parsed.nombre ?? null,
        parsed.email ?? null,
        parsed.telefono ?? null,
        parsed.pais ?? null,
        cliente?.segmento || null,
      ]
    );

    const pideLink = LINK_REQUEST_REGEX.test(userInput || "");
    const paymentLink = extractPaymentLinkFromPrompt(promptBase);

    return {
      action: "reply",
      replySource: "pago-datos",
      intent: "pago",
      dbUpdated: true,
      facts: {
        EVENT: "PAYMENT_DETAILS_RECEIVED",
        LANGUAGE: idiomaDestino,
        PAYMENT_LINK_AVAILABLE: Boolean(paymentLink),
        PAYMENT_LINK: paymentLink || null,
        USER_REQUESTED_LINK: pideLink,
        INSTRUCTION: "ASK_USER_TO_TEXT_PAGO_REALIZADO_AFTER_PAYMENT",
      },
      transition: {
        flow: "generic_sales",
        step: "details",
        patchCtx: {
          guard: "payment",
          awaiting_field: "payment_details",
          last_bot_action: "payment_details_saved",
        },
      },
    };
  }

  // 7) No aplica → sigue el pipeline
  return { action: "continue" };
}

export async function paymentHumanGate(event: TurnEvent): Promise<GateResult> {
  const e = event as any;

  const result = await paymentHumanGuard({
    pool: e.pool,
    tenantId: e.tenantId,
    canal: e.canal,
    contacto: e.senderId || e.contacto, // ✅ usa senderId (nuevo estándar)
    userInput: e.userInput,
    idiomaDestino: e.idiomaDestino,
    promptBase: e.promptBase,

    parseDatosCliente: e.parseDatosCliente,
    extractPaymentLinkFromPrompt: e.extractPaymentLinkFromPrompt,
  });

  if (result.action === "continue") return { action: "continue" };

  if (result.action === "silence") {
    return { action: "silence", reason: result.reason };
  }

  // result.action === "reply"
  return {
    action: "reply",
    replySource: result.replySource,
    intent: result.intent,
    facts: result.facts,
    transition: result.transition
      ? { effects: null, nextAction: null, ...result.transition }
      : undefined,
  } as any;
}
