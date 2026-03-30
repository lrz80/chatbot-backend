// backend/src/lib/guards/paymentHumanGuard.ts
import type { Pool } from "pg";
import type { Canal } from "../../lib/detectarIntencion";
import type { TurnEvent, GateResult } from "../conversation/stateMachine";
import { setHumanOverride } from "../humanOverride/setHumanOverride";

type Idioma = "es" | "en";

const ESPERANDO_PAGO_TTL_HOURS = Math.max(
  1,
  Number(process.env.ESPERANDO_PAGO_TTL_HOURS || "12")
);

type ParsedDatosCliente = null | {
  nombre?: string | null;
  email?: string | null;
  telefono?: string | null;
  pais?: string | null;
};

export type PaymentGuardResult =
  | { action: "continue" }
  | { action: "silence"; reason: "human_override" | "pago_en_confirmacion" }
  | {
      action: "reply";
      replySource:
        | "pago-confirm"
        | "pago-datos"
        | "pago-link"
        | "pago-link-missing";
      intent: "pago";
      facts: Record<string, any>;
      dbUpdated?: boolean;
      transition?: {
        flow?: string;
        step?: string;
        patchCtx?: any;
      };
    };

type PaymentStateSnapshot = {
  estadoActual: string;
  humanOverride: boolean;
  overrideActive: boolean;
  cliente: any;
};

function normalizeEstado(value: any): string {
  return String(value || "").trim().toLowerCase();
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object";
}

function getConvoCtx(event: any): Record<string, any> {
  return isObject(event?.convoCtx) ? event.convoCtx : {};
}

function getActiveFlow(event: any): string | null {
  const value = event?.activeFlow;
  return typeof value === "string" ? value : null;
}

function getActiveStep(event: any): string | null {
  const value = event?.activeStep;
  return typeof value === "string" ? value : null;
}

function getStructuredPaymentSignal(ctx: Record<string, any>): string | null {
  const value =
    ctx?.payment_signal ??
    ctx?.paymentSignal ??
    ctx?.payment?.signal ??
    ctx?.payment?.event ??
    null;

  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function hasActivePaymentState(input: {
  estadoActual: string;
  ctx: Record<string, any>;
  activeFlow: string | null;
  activeStep: string | null;
}): boolean {
  const { estadoActual, ctx, activeFlow, activeStep } = input;

  if (estadoActual === "esperando_pago" || estadoActual === "pago_en_confirmacion") {
    return true;
  }

  if (ctx?.payment?.active === true) {
    return true;
  }

  if (ctx?.guard === "payment") {
    return true;
  }

  if (ctx?.awaiting_field === "payment_details") {
    return true;
  }

  if (activeFlow === "payment") {
    return true;
  }

  if (activeStep === "payment" || activeStep === "details") {
    return true;
  }

  return false;
}

function shouldTreatAsPaymentDetails(input: {
  parsed: ParsedDatosCliente;
  estadoActual: string;
  ctx: Record<string, any>;
  activeFlow: string | null;
  activeStep: string | null;
}): boolean {
  const { parsed, estadoActual, ctx, activeFlow, activeStep } = input;

  if (!parsed) return false;

  if (estadoActual === "esperando_pago") {
    return true;
  }

  if (ctx?.awaiting_field === "payment_details") {
    return true;
  }

  if (ctx?.guard === "payment") {
    return true;
  }

  if (ctx?.payment?.active === true) {
    return true;
  }

  if (activeFlow === "payment") {
    return true;
  }

  if (activeStep === "details") {
    return true;
  }

  return false;
}

function shouldTreatAsPaymentConfirmation(input: {
  ctx: Record<string, any>;
  activeFlow: string | null;
  activeStep: string | null;
}): boolean {
  const { ctx, activeFlow, activeStep } = input;

  const signal = getStructuredPaymentSignal(ctx);

  if (signal === "confirmed" || signal === "payment_confirmed") {
    return true;
  }

  if (ctx?.payment?.confirmationDeclared === true) {
    return true;
  }

  if (ctx?.payment_confirmation_declared === true) {
    return true;
  }

  if (activeFlow === "payment_confirmation") {
    return true;
  }

  if (activeStep === "payment_confirmation") {
    return true;
  }

  return false;
}

async function readClienteState(input: {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  contacto: string;
}): Promise<PaymentStateSnapshot> {
  const { pool, tenantId, canal, contacto } = input;

  const { rows } = await pool.query(
    `
    SELECT
      estado,
      updated_at,
      human_override,
      human_override_until,
      nombre,
      email,
      telefono,
      pais,
      segmento
    FROM clientes
    WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
    LIMIT 1
    `,
    [tenantId, canal, contacto]
  );

  const cliente = rows[0] || null;
  let estadoActual = normalizeEstado(cliente?.estado);
  const humanOverride = cliente?.human_override === true;

  if (estadoActual === "esperando_pago" && cliente?.updated_at) {
    const updatedAtMs = new Date(cliente.updated_at).getTime();
    const ageMs = Date.now() - updatedAtMs;
    const ttlMs = ESPERANDO_PAGO_TTL_HOURS * 60 * 60 * 1000;

    if (Number.isFinite(updatedAtMs) && ageMs > ttlMs) {
      try {
        await pool.query(
          `
          UPDATE clientes
          SET estado = NULL,
              updated_at = NOW()
          WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
          `,
          [tenantId, canal, contacto]
        );
        estadoActual = "";
      } catch {
        // no bloquear
      }
    }
  }

  const until = cliente?.human_override_until
    ? new Date(cliente.human_override_until)
    : null;

  const overrideActive =
    humanOverride && Boolean(until) && (until as Date).getTime() > Date.now();

  return {
    estadoActual,
    humanOverride,
    overrideActive,
    cliente,
  };
}

export async function paymentHumanGuard(opts: {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  contacto: string;
  userInput: string;
  idiomaDestino: Idioma;
  promptBase: string;
  parseDatosCliente: (text: string) => ParsedDatosCliente;
  extractPaymentLinkFromPrompt: (prompt: string) => string | null;
  convoCtx?: Record<string, any>;
  activeFlow?: string | null;
  activeStep?: string | null;
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
    convoCtx = {},
    activeFlow = null,
    activeStep = null,
  } = opts;

  const {
    estadoActual,
    humanOverride,
    overrideActive,
    cliente,
  } = await readClienteState({
    pool,
    tenantId,
    canal,
    contacto,
  });

  if (overrideActive) {
    return { action: "silence", reason: "human_override" };
  }

  if (humanOverride && !overrideActive) {
    try {
      await pool.query(
        `
        UPDATE clientes
        SET human_override = false,
            human_override_until = NULL,
            updated_at = NOW()
        WHERE tenant_id = $1 AND canal = $2 AND contacto = $3
        `,
        [tenantId, canal, contacto]
      );
    } catch {
      // no bloquear
    }
  }

  if (estadoActual === "pago_en_confirmacion") {
    return { action: "silence", reason: "pago_en_confirmacion" };
  }

  const paymentStateActive = hasActivePaymentState({
    estadoActual,
    ctx: convoCtx,
    activeFlow,
    activeStep,
  });

  if (!paymentStateActive) {
    return { action: "continue" };
  }

  const parsed = parseDatosCliente(userInput || "");

  if (
    shouldTreatAsPaymentConfirmation({
      ctx: convoCtx,
      activeFlow,
      activeStep,
    })
  ) {
    await pool.query(
      `
      INSERT INTO clientes (tenant_id, canal, contacto, estado, updated_at)
      VALUES ($1, $2, $3, 'pago_en_confirmacion', NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET estado = 'pago_en_confirmacion', updated_at = NOW()
      `,
      [tenantId, canal, contacto]
    );

    await setHumanOverride({
      tenantId,
      canal,
      contacto,
      minutes: 5,
      reason: "pago_confirmado",
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
        NEXT_STEP: "TEAM_WILL_CONFIRM_AND_ACTIVATE",
      },
      transition: {
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          guard: "payment",
          payment_status: "confirmed_by_user",
          payment_signal: null,
          last_bot_action: "payment_confirm_received",
        },
      },
    };
  }

  if (
    shouldTreatAsPaymentDetails({
      parsed,
      estadoActual,
      ctx: convoCtx,
      activeFlow,
      activeStep,
    })
  ) {
    await pool.query(
      `
      INSERT INTO clientes (
        tenant_id,
        canal,
        contacto,
        nombre,
        email,
        telefono,
        pais,
        segmento,
        estado,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'lead'), 'esperando_pago', NOW())
      ON CONFLICT (tenant_id, canal, contacto)
      DO UPDATE SET
        nombre = COALESCE(EXCLUDED.nombre, clientes.nombre),
        email = COALESCE(EXCLUDED.email, clientes.email),
        telefono = COALESCE(EXCLUDED.telefono, clientes.telefono),
        pais = COALESCE(EXCLUDED.pais, clientes.pais),
        estado = 'esperando_pago',
        updated_at = NOW()
      `,
      [
        tenantId,
        canal,
        contacto,
        parsed?.nombre ?? null,
        parsed?.email ?? null,
        parsed?.telefono ?? null,
        parsed?.pais ?? null,
        cliente?.segmento || null,
      ]
    );

    const paymentLink = extractPaymentLinkFromPrompt(promptBase);

    return {
      action: "reply",
      replySource: paymentLink ? "pago-datos" : "pago-link-missing",
      intent: "pago",
      dbUpdated: true,
      facts: {
        EVENT: "PAYMENT_DETAILS_RECEIVED",
        LANGUAGE: idiomaDestino,
        PAYMENT_LINK_AVAILABLE: Boolean(paymentLink),
        PAYMENT_LINK: paymentLink || null,
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

  const paymentLink = extractPaymentLinkFromPrompt(promptBase);

  if (estadoActual === "esperando_pago" && paymentLink) {
    return {
      action: "reply",
      replySource: "pago-link",
      intent: "pago",
      facts: {
        EVENT: "PAYMENT_LINK_AVAILABLE",
        LANGUAGE: idiomaDestino,
        PAYMENT_LINK_AVAILABLE: true,
        PAYMENT_LINK: paymentLink,
      },
      transition: {
        flow: "generic_sales",
        step: "close",
        patchCtx: {
          guard: "payment",
          payment_link_sent: true,
          last_bot_action: "payment_link_available",
        },
      },
    };
  }

  return { action: "continue" };
}

export async function paymentHumanGate(event: TurnEvent): Promise<GateResult> {
  const e = event as any;
  const convoCtx = getConvoCtx(e);
  const activeFlow = getActiveFlow(e);
  const activeStep = getActiveStep(e);

  const result = await paymentHumanGuard({
    pool: e.pool,
    tenantId: e.tenantId,
    canal: e.canal,
    contacto: e.senderId || e.contacto,
    userInput: e.userInput,
    idiomaDestino: e.idiomaDestino,
    promptBase: e.promptBase,
    parseDatosCliente: e.parseDatosCliente,
    extractPaymentLinkFromPrompt: e.extractPaymentLinkFromPrompt,
    convoCtx,
    activeFlow,
    activeStep,
  });

  if (result.action === "continue") {
    return { action: "continue" };
  }

  if (result.action === "silence") {
    return {
      action: "silence",
      reason: result.reason,
    };
  }

  return {
    action: "reply",
    replySource: result.replySource,
    intent: result.intent,
    facts: result.facts,
    transition: result.transition
      ? { ...result.transition }
      : undefined,
  } as GateResult;
}