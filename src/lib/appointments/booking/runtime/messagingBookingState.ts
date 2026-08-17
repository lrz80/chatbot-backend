// src/lib/appointments/booking/runtime/messagingBookingState.ts

import type { CallState } from "../../../voice/types";

export const BOOKING_RUNTIME_CONTEXT_KEY =
  "booking_runtime";

/**
 * TTL independiente del booking.
 *
 * No afecta el TTL general de conversation_state.
 * Si el cliente abandona un booking durante más de
 * 30 minutos, el siguiente mensaje ya no pertenece
 * automáticamente a ese booking.
 */
export const MESSAGING_BOOKING_IDLE_TTL_MS =
  30 * 60 * 1000;

export type MessagingBookingRuntimeContext = {
  active: boolean;
  started_at: number | null;
  updated_at: number | null;
  state: CallState;
};

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value)
  );
}

function emptyBookingState(): CallState {
  return {
    bookingData: {},
  };
}

function normalizeCallState(
  value: unknown
): CallState {
  if (!isRecord(value)) {
    return emptyBookingState();
  }

  const bookingData = isRecord(
    value.bookingData
  )
    ? Object.fromEntries(
        Object.entries(
          value.bookingData
        ).map(
          ([key, rawValue]) => [
            key,
            String(
              rawValue ?? ""
            ).trim(),
          ]
        )
      )
    : {};

  return {
    ...(value as CallState),
    bookingData,
  };
}

function isRuntimeExpired(
  updatedAt: number | null
): boolean {
  if (
    updatedAt === null ||
    !Number.isFinite(updatedAt)
  ) {
    return false;
  }

  const idleMs =
    Date.now() - updatedAt;

  return (
    idleMs >
    MESSAGING_BOOKING_IDLE_TTL_MS
  );
}

export function readMessagingBookingRuntime(
  conversationContext: unknown
): MessagingBookingRuntimeContext {
  const context =
    isRecord(conversationContext)
      ? conversationContext
      : {};

  const rawRuntime =
    context[
      BOOKING_RUNTIME_CONTEXT_KEY
    ];

  if (!isRecord(rawRuntime)) {
    return {
      active: false,
      started_at: null,
      updated_at: null,
      state: emptyBookingState(),
    };
  }

  const startedAt =
    typeof rawRuntime.started_at ===
      "number"
      ? rawRuntime.started_at
      : null;

  const updatedAt =
    typeof rawRuntime.updated_at ===
      "number"
      ? rawRuntime.updated_at
      : null;

  const rawActive =
    rawRuntime.active === true;

  const expired =
    rawActive &&
    isRuntimeExpired(updatedAt);

  /**
   * Un runtime expirado se trata como un booking
   * completamente nuevo/inactivo.
   *
   * No reutilizamos:
   * - step pendiente
   * - respuestas anteriores
   * - idioma bloqueado
   * - started_at anterior
   *
   * Esto evita revivir un booking abandonado.
   */
  if (expired) {
    return {
      active: false,
      started_at: null,
      updated_at: updatedAt,
      state: emptyBookingState(),
    };
  }

  return {
    active: rawActive,

    started_at: startedAt,

    updated_at: updatedAt,

    state: normalizeCallState(
      rawRuntime.state
    ),
  };
}

export function buildMessagingBookingRuntimePatch(
  params: {
    previousContext: unknown;
    state: CallState;
    active: boolean;
  }
): Record<string, unknown> {
  const previousRuntime =
    readMessagingBookingRuntime(
      params.previousContext
    );

  const now = Date.now();

  return {
    [BOOKING_RUNTIME_CONTEXT_KEY]: {
      active: params.active,

      /**
       * Si el runtime anterior expiró,
       * readMessagingBookingRuntime()
       * devuelve started_at:null.
       *
       * Por lo tanto un booking nuevo
       * recibe un started_at nuevo.
       */
      started_at:
        previousRuntime.active
          ? (
              previousRuntime
                .started_at ??
              now
            )
          : now,

      updated_at: now,

      state: {
        ...params.state,

        bookingData: {
          ...(
            params.state
              .bookingData || {}
          ),
        },
      },
    },
  };
}

export function clearMessagingBookingRuntimePatch():
  Record<string, unknown> {
  return {
    [BOOKING_RUNTIME_CONTEXT_KEY]: {
      active: false,
      started_at: null,
      updated_at: Date.now(),
      state: emptyBookingState(),
    },
  };
}

export function isMessagingBookingActive(
  conversationContext: unknown
): boolean {
  const runtime =
    readMessagingBookingRuntime(
      conversationContext
    );

  return (
    runtime.active === true &&
    (
      typeof runtime.state
        .bookingStepIndex ===
        "number" ||
      Boolean(
        String(
          runtime.state
            .pendingBookingStepKey ||
            ""
        ).trim()
      )
    )
  );
}