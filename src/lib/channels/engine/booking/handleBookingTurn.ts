// src/lib/channels/engine/booking/handleBookingTurn.ts

import type { Pool } from "pg";

import type { Canal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import type {
  CallState,
  VoiceLocale,
} from "../../../voice/types";

import {
  startSharedBookingFlow,
} from "../../../appointments/booking/runtime/startSharedBookingFlow";

import {
  submitSharedBookingStep,
} from "../../../appointments/booking/runtime/submitSharedBookingStep";

import {
  createSharedAppointment,
} from "../../../appointments/booking/runtime/createSharedAppointment";

import {
  buildMessagingBookingRuntimePatch,
  readMessagingBookingRuntime,
} from "../../../appointments/booking/runtime/messagingBookingState";

type TransitionFn = (params: {
  flow?: string;
  step?: string;
  patchCtx?: any;
}) => void;

type BookingCanal =
  | "whatsapp"
  | "facebook"
  | "instagram";

function toBookingCanal(
  canal: Canal | string
): BookingCanal {
  if (canal === "whatsapp") {
    return "whatsapp";
  }

  if (
    canal === "facebook" ||
    canal === "instagram"
  ) {
    return canal;
  }

  if (canal === "meta") {
    return "facebook";
  }

  return "whatsapp";
}

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export type HandleBookingTurnArgs = {
  /**
   * Se conserva temporalmente en el contrato exterior.
   * El runtime nuevo usa los repositorios canónicos.
   */
  pool: Pool;

  tenantId: string;
  canal: Canal | string;
  contactoNorm: string;
  idiomaDestino: LangCode;
  userInput: string;
  messageId: string | null;

  tenant: any;
  bookingConfig: any;

  ctx: any;

  bookingEnabled: boolean;
  promptBase: string;
  bookingLink?: string | null;

  detectedIntent: string | null;
  intentFallback: string | null;

  /**
   * Señal estructurada proveniente del router comercial.
   * No se vuelve a interpretar el texto aquí.
   */
  bookingRequested: boolean;

  mode: "gate" | "guardrail";
  sourceTag: string;

  transition: TransitionFn;
  persistState: (
    nextCtx: any
  ) => Promise<void>;
};

export type HandleBookingTurnResult = {
  handled: boolean;
  reply?: string;
  source?: string;
  intent?: string | null;
  ctx: any;
};

export async function handleBookingTurn(
  args: HandleBookingTurnArgs
): Promise<HandleBookingTurnResult> {
  const {
    tenantId,
    tenant,
    bookingConfig,
    canal,
    contactoNorm,
    idiomaDestino,
    userInput,
    bookingEnabled,
    bookingRequested,
    sourceTag,
    transition,
    persistState,
  } = args;

  let ctxLocal =
    args.ctx &&
    typeof args.ctx === "object"
      ? args.ctx
      : {};

  const bookingCanal =
    toBookingCanal(canal);

  const locale =
    idiomaDestino as VoiceLocale;

  const contactPhone =
    bookingCanal === "whatsapp"
      ? clean(contactoNorm) || null
      : null;

  const sessionId = [
    bookingCanal,
    tenantId,
    clean(contactoNorm),
  ].join(":");

  const persistRuntimeState =
    async (
      state: CallState,
      active: boolean
    ): Promise<void> => {
      const runtimePatch =
        buildMessagingBookingRuntimePatch({
          previousContext: ctxLocal,
          state,
          active,
        });

      const nextCtx = {
        ...ctxLocal,
        ...runtimePatch,
      };

      await persistState(nextCtx);
      ctxLocal = nextCtx;
    };

  const runtime =
    readMessagingBookingRuntime(
      ctxLocal
    );

  /*
   * Un booking ya activo siempre tiene prioridad.
   * La respuesta actual pertenece al step pendiente,
   * aunque el router general no vuelva a marcar
   * wantsBooking en cada mensaje.
   */
  if (runtime.active) {
    const submitted =
      await submitSharedBookingStep({
        tenantId,
        sessionId,
        locale,
        contactPhone,
        userInput,
        state: runtime.state,

        tenant,
        cfg: bookingConfig,

        persistState: async (
          nextState
        ) => {
          await persistRuntimeState(
            nextState,
            true
          );
        },
      });

    /*
     * La confirmación final ya fue aceptada.
     * Ahora se crea realmente la cita con el canal
     * correcto.
     */
    if (
      submitted.ok &&
      submitted.action_required ===
        "create_appointment"
    ) {
      const created =
        await createSharedAppointment({
          tenantId,
          channel: bookingCanal,
          sessionId,
          locale,
          contactPhone,
          state: submitted.state,
        });

      await persistRuntimeState(
        created.state,
        !created.flow_complete
      );

      transition({
        flow: created.flow_complete
          ? "generic_sales"
          : "booking",
        step:
          created.next_required_step
            ?.step_key ||
          (created.flow_complete
            ? "complete"
            : "active"),
        patchCtx: ctxLocal,
      });

      const reply = clean(
        created.assistant_prompt
      );

      if (reply) {
        return {
          handled: true,
          reply,
          source:
            `${sourceTag}:shared_booking_create`,
          intent: "booking",
          ctx: ctxLocal,
        };
      }

      /*
       * La cita puede quedar creada sin un step
       * informativo posterior. En ese caso permitimos
       * que el pipeline general redacte el cierre usando
       * el resultado persistido, en vez de inventar aquí
       * un mensaje fijo.
       */
      return {
        handled: true,
        source:
          `${sourceTag}:shared_booking_created`,
        intent: "booking",
        ctx: ctxLocal,
      };
    }

    await persistRuntimeState(
      submitted.state,
      !submitted.flow_complete
    );

    transition({
      flow: submitted.flow_complete
        ? "generic_sales"
        : "booking",
      step:
        submitted.next_required_step
          ?.step_key ||
        (submitted.flow_complete
          ? "complete"
          : "active"),
      patchCtx: ctxLocal,
    });

    const reply = clean(
      submitted.assistant_prompt
    );

    const retryReply = clean(
      submitted.next_required_step
        ?.retry_prompt ||
      submitted.next_required_step
        ?.prompt
    );

    const effectiveReply =
      reply || retryReply;

    if (effectiveReply) {
      return {
        handled: true,
        reply: effectiveReply,
        source:
          submitted.ok
            ? `${sourceTag}:shared_booking_submit`
            : `${sourceTag}:shared_booking_retry`,
        intent: "booking",
        ctx: ctxLocal,
      };
    }

    /**
     * Si el runtime de booking está activo,
     * el turno pertenece exclusivamente al booking.
     * Nunca debe caer al pipeline conversacional general.
     */
    return {
      handled: true,
      source:
        `${sourceTag}:shared_booking_submit_no_prompt`,
      intent: "booking",
      ctx: ctxLocal,
    };
  }

  /*
   * No inicia un flujo nuevo si booking está apagado
   * o el router no produjo una intención estructurada
   * de reserva.
   */
  if (
    !bookingEnabled ||
    !bookingRequested
  ) {
    return {
      handled: false,
      ctx: ctxLocal,
    };
  }

  const initialBookingData: Record<string, string> = {};

  /**
   * Reutiliza información estructurada que el pipeline
   * ya conoce antes de iniciar booking.
   *
   * No volvemos a interpretar userInput aquí.
   */
  const structuredService =
    ctxLocal?.structuredService &&
    typeof ctxLocal.structuredService === "object"
      ? ctxLocal.structuredService
      : null;

  const knownService = clean(
    structuredService?.name ||
      structuredService?.service_name ||
      structuredService?.serviceName ||
      structuredService?.label ||
      ctxLocal?.last_service_name ||
      ctxLocal?.last_service_label
  );

  if (knownService) {
    initialBookingData.service =
      knownService;
  }

  const knownCustomerName = clean(
    ctxLocal?.customer_name ||
      ctxLocal?.customerName
  );

  if (knownCustomerName) {
    initialBookingData.customer_name =
      knownCustomerName;
  }

  const knownAddress = clean(
    ctxLocal?.service_address ||
      ctxLocal?.serviceAddress ||
      ctxLocal?.address
  );

  if (knownAddress) {
    initialBookingData.service_address =
      knownAddress;
  }

  const started =
    await startSharedBookingFlow({
      tenantId,
      locale,
      contactPhone,
      state: {
        lang: locale,

        bookingData:
          initialBookingData,

        bookingTurnStatus:
          "waiting_assistant_prompt",
      },
    });

  if (!started.ok) {
    console.error(
      "[SHARED_BOOKING][START_FAILED]",
      {
        tenantId,
        channel: bookingCanal,
        sessionId,
        error: started.error,
        details: started.details,
      }
    );

    return {
      handled: false,
      source:
        `${sourceTag}:shared_booking_start_failed`,
      intent: "booking",
      ctx: ctxLocal,
    };
  }

  await persistRuntimeState(
    started.state,
    !started.flow_complete
  );

  transition({
    flow: started.flow_complete
      ? "generic_sales"
      : "booking",
    step:
      started.next_required_step
        ?.step_key ||
      (started.flow_complete
        ? "complete"
        : "active"),
    patchCtx: ctxLocal,
  });

  const reply = clean(
    started.assistant_prompt
  );

  if (!reply) {
    return {
      handled: false,
      source:
        `${sourceTag}:shared_booking_start_no_prompt`,
      intent: "booking",
      ctx: ctxLocal,
    };
  }

  return {
    handled: true,
    reply,
    source:
      `${sourceTag}:shared_booking_start`,
    intent: "booking",
    ctx: ctxLocal,
  };
}