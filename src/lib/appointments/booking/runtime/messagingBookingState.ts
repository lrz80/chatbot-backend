// src/lib/appointments/booking/runtime/messagingBookingState.ts

import type { CallState } from "../../../voice/types";

export const BOOKING_RUNTIME_CONTEXT_KEY = "booking_runtime";

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

function normalizeCallState(
  value: unknown
): CallState {
  if (!isRecord(value)) {
    return {
      bookingData: {},
    };
  }

  const bookingData = isRecord(value.bookingData)
    ? Object.fromEntries(
        Object.entries(value.bookingData).map(
          ([key, rawValue]) => [
            key,
            String(rawValue ?? "").trim(),
          ]
        )
      )
    : {};

  return {
    ...(value as CallState),
    bookingData,
  };
}

export function readMessagingBookingRuntime(
  conversationContext: unknown
): MessagingBookingRuntimeContext {
  const context = isRecord(conversationContext)
    ? conversationContext
    : {};

  const rawRuntime = context[
    BOOKING_RUNTIME_CONTEXT_KEY
  ];

  if (!isRecord(rawRuntime)) {
    return {
      active: false,
      started_at: null,
      updated_at: null,
      state: {
        bookingData: {},
      },
    };
  }

  return {
    active: rawRuntime.active === true,

    started_at:
      typeof rawRuntime.started_at === "number"
        ? rawRuntime.started_at
        : null,

    updated_at:
      typeof rawRuntime.updated_at === "number"
        ? rawRuntime.updated_at
        : null,

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

      started_at:
        previousRuntime.started_at ??
        now,

      updated_at: now,

      state: {
        ...params.state,

        bookingData: {
          ...(params.state.bookingData || {}),
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
      state: {
        bookingData: {},
      },
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
      typeof runtime.state.bookingStepIndex ===
        "number" ||
      Boolean(
        String(
          runtime.state.pendingBookingStepKey ||
            ""
        ).trim()
      )
    )
  );
}