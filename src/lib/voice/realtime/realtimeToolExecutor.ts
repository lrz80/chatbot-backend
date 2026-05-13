import { getBookingFlow } from "../../appointments/getBookingFlow";
import {
  resolveBookingPromptText,
  resolveBookingRetryText,
} from "../voiceBookingHelpers";
import { executeCanonicalBookingServiceStep } from "../booking/handleBookingServiceStep";
import { executeCanonicalBookingDatetimeStep } from "../booking/handleBookingDatetimeStep";
import { executeCanonicalBookingConfirmationStep } from "../booking/handleBookingConfirmationStep";
import { executeCanonicalBookingSlotBusyRecovery } from "../voiceBookingBusyRecovery";
import { upsertVoiceCallState } from "../upsertVoiceCallState";
import type { CallState, VoiceLocale } from "../types";
import {
  clean,
  normalizeComparable,
  extractStringRecord,
  getStepSlot,
  getAnswerValueForStep,
  isConfirmationLikeStep,
  isSuccessStep,
  sortFlowSteps,
  canonicalizeGenericStepValue,
  buildAnswersBySlot,
  normalizeAnswersToCanonicalSlots,
  getMissingRequiredFlowSteps,
  getStepIndexByKey,
  getConfirmationLikeStep,
  resolveCurrentStepIndex,
  getNextStepIndex,
  buildCanonicalCallState,
  parseJsonStringArray,
  renderBookingStepTemplate,
  buildBookingPromptTemplateValues,
  extractStepOptionCandidates,
  type BookingFlowStepLike,
  type BookingState,
} from "./realtimeBookingFlowUtils";

type ExecuteRealtimeToolParams = {
  tenantId: string;
  callerPhone: string | null;
  toolName: string;
  args: Record<string, any>;

  tenant?: any;
  cfg?: any;
  callSid?: string;
  didNumber?: string;
  currentLocale?: VoiceLocale;
  state?: CallState;
  userInput?: string;
  digits?: string;
};

type RealtimeBookingContext = {
  tenant: any;
  cfg: any;
  callSid: string;
  didNumber: string;
  currentLocale: VoiceLocale;
  state: CallState;
  userInput: string;
  digits: string;
};

type RealtimeMappedStep = {
  step_key: string;
  step_order: number;
  slot: string;
  prompt: string;
  expected_type: string;
  required: boolean;
  retry_prompt: string;
  validation_config: Record<string, unknown> | null;
  prompt_translations: Record<string, unknown> | null;
  retry_prompt_translations: Record<string, unknown> | null;
};

function getRealtimeBookingContext(
  params: ExecuteRealtimeToolParams
): RealtimeBookingContext | null {
  const {
    tenant,
    cfg,
    callSid,
    didNumber,
    currentLocale,
    state,
    userInput,
    digits,
  } = params;

  if (!tenant || !callSid || !didNumber || !currentLocale || !state) {
    return null;
  }

  return {
    tenant,
    cfg: cfg ?? {},
    callSid,
    didNumber,
    currentLocale,
    state,
    userInput: clean(userInput),
    digits: clean(digits),
  };
}

function mapStepForRealtime(
  step: BookingFlowStepLike,
  locale?: VoiceLocale
): RealtimeMappedStep {
  const resolvedPrompt = locale
    ? resolveBookingPromptText({
        locale,
        prompt: step.prompt || "",
        promptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.prompt || "";

  const resolvedRetryPrompt = locale
    ? resolveBookingRetryText({
        locale,
        retryPrompt: step.retry_prompt || "",
        retryPromptTranslations:
          (step.retry_prompt_translations as Record<string, string> | null) ||
          null,
        fallbackPrompt: step.prompt || "",
        fallbackPromptTranslations:
          (step.prompt_translations as Record<string, string> | null) || null,
      })
    : step.retry_prompt || "";

  return {
    step_key: clean(step.step_key),
    step_order: Number(step.step_order || 0),
    slot: getStepSlot(step),
    prompt: resolvedPrompt,
    expected_type: step.expected_type || "text",
    required: step.required === true,
    retry_prompt: resolvedRetryPrompt,
    validation_config: step.validation_config || null,
    prompt_translations: step.prompt_translations || null,
    retry_prompt_translations: step.retry_prompt_translations || null,
  };
}

function mapFlowStepsForRealtime(
  steps: BookingFlowStepLike[],
  locale?: VoiceLocale
): RealtimeMappedStep[] {
  return sortFlowSteps(steps).map((step) => mapStepForRealtime(step, locale));
}

function buildRealtimeBookingState(params: {
  steps: BookingFlowStepLike[];
  state: CallState;
  explicitCurrentIndex?: number | null;
  finalConfirmationGranted?: boolean;
  readyToCreate?: boolean;
}): BookingState {
  const {
    steps,
    state,
    explicitCurrentIndex,
    finalConfirmationGranted = false,
    readyToCreate = false,
  } = params;

  const answersBySlot = normalizeAnswersToCanonicalSlots({
    steps,
    answersBySlot: extractStringRecord(state.bookingData),
  });

  const currentIndex =
    typeof explicitCurrentIndex === "number"
      ? explicitCurrentIndex
      : resolveCurrentStepIndex({
          steps,
          state,
          answersBySlot,
        });

  const currentStep =
    typeof currentIndex === "number" ? steps[currentIndex] : null;

  return {
    current_step_key: currentStep ? clean(currentStep.step_key) || null : null,
    current_step_slot: currentStep ? getStepSlot(currentStep) || null : null,
    awaiting_confirmation: currentStep ? isConfirmationLikeStep(currentStep) : false,
    final_confirmation_granted: finalConfirmationGranted,
    ready_to_create: readyToCreate,
    collected_slots: answersBySlot,
  };
}

function buildNextRequiredStep(params: {
  steps: BookingFlowStepLike[];
  bookingState: BookingState;
  locale?: VoiceLocale;
  overridePrompt?: string;
}): RealtimeMappedStep | null {
  const { steps, bookingState, locale, overridePrompt } = params;

  if (!bookingState.current_step_key) {
    return null;
  }

  const step = steps.find(
    (candidate) =>
      clean(candidate.step_key) === clean(bookingState.current_step_key)
  );

  if (!step) {
    return null;
  }

  const mapped = mapStepForRealtime(step, locale);
  const templateValues = buildBookingPromptTemplateValues(bookingState);

  const renderedPrompt = renderBookingStepTemplate(
    overridePrompt || mapped.prompt,
    templateValues
  );

  const renderedRetryPrompt = renderBookingStepTemplate(
    mapped.retry_prompt,
    templateValues
  );

  return {
    ...mapped,
    prompt: renderedPrompt,
    retry_prompt: renderedRetryPrompt,
  };
}

async function persistVoiceState(params: {
  tenantId: string;
  callSid: string;
  state: CallState;
  locale: VoiceLocale;
}): Promise<void> {
  const { tenantId, callSid, state, locale } = params;

  await upsertVoiceCallState({
    callSid,
    tenantId,
    lang: state.lang ?? locale,
    turn: state.turn ?? 0,
    awaiting: state.awaiting ?? false,
    pendingType: state.pendingType ?? null,
    awaitingNumber: state.awaitingNumber ?? false,
    altDest: state.altDest ?? null,
    smsSent: state.smsSent ?? false,
    bookingStepIndex:
      typeof state.bookingStepIndex === "number" ? state.bookingStepIndex : null,
    bookingData: state.bookingData || {},
  });
}

function buildContextMissingResult() {
  return {
    ok: false,
    error: "REALTIME_BOOKING_CONTEXT_MISSING",
    message:
      "Realtime booking context is missing. The realtime bridge must pass tenant, callSid, didNumber, currentLocale, state, userInput, and digits.",
  };
}

export async function executeRealtimeTool(
  params: ExecuteRealtimeToolParams
): Promise<any> {
  const { tenantId, callerPhone, toolName, args } = params;

  const bookingContext =
    toolName === "get_booking_flow" ||
    toolName === "submit_booking_step" ||
    toolName === "create_appointment"
      ? getRealtimeBookingContext(params)
      : null;

  switch (toolName) {
    case "get_booking_flow": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
          state: bookingContext.state,
        }),
      });

      const initialState = buildCanonicalCallState({
        state: bookingContext.state,
        answersBySlot,
        bookingStepIndex: resolveCurrentStepIndex({
          steps,
          state: bookingContext.state,
          answersBySlot,
        }),
      });

      const bookingState = buildRealtimeBookingState({
        steps,
        state: initialState,
      });

      return {
        ok: true,
        steps: mapFlowStepsForRealtime(steps, bookingContext.currentLocale),
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
        }),
      };
    }

    case "submit_booking_step": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const stepKey = clean(args.step_key);
      const value = clean(args.value);

      if (!stepKey) {
        return {
          ok: false,
          error: "MISSING_STEP_KEY",
          message: "step_key is required.",
        };
      }

      const currentIndex = getStepIndexByKey(steps, stepKey);
      if (currentIndex === -1) {
        return {
          ok: false,
          error: "UNKNOWN_BOOKING_STEP",
          message: `Unknown booking step: ${stepKey}`,
        };
      }

      const currentStep = steps[currentIndex];
      const targetSlot = getStepSlot(currentStep);

      if (!targetSlot) {
        return {
          ok: false,
          error: "BOOKING_STEP_WITHOUT_SLOT",
          message: `Booking step ${stepKey} has no canonical slot.`,
        };
      }

      const rawAnswers = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
          state: bookingContext.state,
        }),
      });

      let workingState = buildCanonicalCallState({
        state: bookingContext.state,
        answersBySlot: rawAnswers,
        bookingStepIndex: currentIndex,
      });

      const rawSlot =
        typeof currentStep.validation_config?.slot === "string"
          ? currentStep.validation_config.slot.trim()
          : "";

      const isServiceStep =
        clean(currentStep.step_key) === "service" || rawSlot === "service";

      const isDatetimeStep =
        clean(currentStep.step_key) === "datetime" || rawSlot === "datetime";

      const isConfirmationStep = isConfirmationLikeStep(currentStep);

      if (isServiceStep) {
        const serviceResult = await executeCanonicalBookingServiceStep({
          currentStep: currentStep as any,
          currentLocale: bookingContext.currentLocale,
          callerE164: callerPhone,
          effectiveUserInput: value,
          state: workingState,
          rawConfig: bookingContext.cfg?.booking_services_text || "",
        });

        if (serviceResult.kind === "retry" || serviceResult.kind === "ambiguous") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: workingState,
            explicitCurrentIndex: currentIndex,
          });

          return {
            ok: false,
            error:
              serviceResult.kind === "ambiguous"
                ? "AMBIGUOUS_BOOKING_SERVICE"
                : "UNRESOLVED_BOOKING_SERVICE",
            message: serviceResult.prompt,
            assistant_prompt: serviceResult.prompt,
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
              overridePrompt: serviceResult.prompt,
            }),
            service_options:
              serviceResult.kind === "ambiguous" ? serviceResult.options : [],
          };
        }

        const nextAnswers = {
          ...rawAnswers,
          [targetSlot]: serviceResult.resolvedValue,
          [stepKey]: serviceResult.resolvedValue,
        };

        workingState = buildCanonicalCallState({
          state: serviceResult.state,
          answersBySlot: nextAnswers,
          bookingStepIndex: currentIndex,
        });
      } else if (isDatetimeStep) {
        const datetimeResult = await executeCanonicalBookingDatetimeStep({
          tenantId,
          callSid: bookingContext.callSid,
          currentStep: currentStep as any,
          currentIndex,
          currentLocale: bookingContext.currentLocale,
          callerE164: callerPhone,
          state: workingState,
          resolvedStepValue: value,
        });

        if (datetimeResult.kind === "retry") {
          const retryState = datetimeResult.state;
          const bookingState = buildRealtimeBookingState({
            steps,
            state: retryState,
            explicitCurrentIndex: currentIndex,
          });

          return {
            ok: false,
            error:
              datetimeResult.context === "slot_unavailable"
                ? "SLOT_UNAVAILABLE"
                : "INVALID_DATETIME_STEP",
            message: datetimeResult.prompt,
            assistant_prompt: datetimeResult.prompt,
            suggested_times: parseJsonStringArray(
              retryState.bookingData?.__datetime_reference_suggested_starts
            ),
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
              overridePrompt: datetimeResult.prompt,
            }),
          };
        }

        const nextAnswers = {
          ...rawAnswers,
          [targetSlot]: datetimeResult.resolvedValue,
          [stepKey]: datetimeResult.resolvedValue,
          datetime: clean(
            datetimeResult.nextState.bookingData?.datetime ||
              datetimeResult.resolvedValue
          ),
          datetime_iso: clean(
            datetimeResult.nextState.bookingData?.datetime_iso || ""
          ),
          datetime_display: clean(
            datetimeResult.nextState.bookingData?.datetime_display ||
              datetimeResult.resolvedValue
          ),
        };

        workingState = buildCanonicalCallState({
          state: datetimeResult.nextState,
          answersBySlot: nextAnswers,
          bookingStepIndex: currentIndex,
        });
      } else if (isConfirmationStep) {
        const confirmationResult = await executeCanonicalBookingConfirmationStep({
          tenant: bookingContext.tenant,
          cfg: bookingContext.cfg,
          flow: steps as any,
          currentStep: currentStep as any,
          currentLocale: bookingContext.currentLocale,
          callSid: bookingContext.callSid,
          didNumber: bookingContext.didNumber,
          callerE164: callerPhone,
          userInput: bookingContext.userInput || value,
          digits: bookingContext.digits,
          state: workingState,
          upsertVoiceCallState,
        });

        if (confirmationResult.kind === "busy_recovery") {
          const busyRecovered = await executeCanonicalBookingSlotBusyRecovery({
            flow: steps as any,
            state: confirmationResult.state,
            tenantId,
            callSid: bookingContext.callSid,
            currentLocale: bookingContext.currentLocale,
            callerE164: callerPhone,
            timeZone: confirmationResult.busyRecovery.timeZone,
            suggestedStarts: confirmationResult.busyRecovery.suggestedStarts,
          });

          const bookingState = buildRealtimeBookingState({
            steps,
            state: busyRecovered.state,
            explicitCurrentIndex: busyRecovered.datetimeStepIndex,
          });

          return {
            ok: false,
            error: "SLOT_UNAVAILABLE",
            message: busyRecovered.prompt,
            assistant_prompt: busyRecovered.prompt,
            suggested_times: parseJsonStringArray(
              busyRecovered.state.bookingData?.__booking_busy_suggested_starts
            ),
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
              overridePrompt: busyRecovered.prompt,
            }),
          };
        }

        if (confirmationResult.kind === "retry") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: currentIndex,
          });

          return {
            ok: false,
            error: "CONFIRMATION_RETRY",
            message: confirmationResult.prompt,
            assistant_prompt: confirmationResult.prompt,
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
              overridePrompt: confirmationResult.prompt,
            }),
          };
        }

        if (confirmationResult.kind === "failed") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: null,
          });

          return {
            ok: false,
            error: "BOOKING_FAILED",
            message: confirmationResult.prompt,
            assistant_prompt: confirmationResult.prompt,
            booking_outcome: "failed",
            booking_state: bookingState,
            next_required_step: null,
          };
        }

        if (confirmationResult.kind === "cancelled") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: null,
          });

          return {
            ok: true,
            message: confirmationResult.prompt,
            assistant_prompt: confirmationResult.prompt,
            booking_outcome: "cancelled",
            booking_state: bookingState,
            next_required_step: null,
          };
        }

        if (confirmationResult.kind === "awaiting_sms_destination") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: null,
          });

          return {
            ok: true,
            booking_outcome: "awaiting_sms_destination",
            requires_sms_destination: true,
            booking_state: bookingState,
            next_required_step: null,
          };
        }

        if (confirmationResult.kind === "success_offer_sms") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex:
              typeof confirmationResult.state.bookingStepIndex === "number"
                ? confirmationResult.state.bookingStepIndex
                : null,
          });

          return {
            ok: true,
            message: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
            assistant_prompt: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
            booking_outcome: "confirmed_offer_sms",
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
              overridePrompt: confirmationResult.smsOfferPrompt,
            }),
          };
        }

        if (confirmationResult.kind === "success") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: null,
          });

          return {
            ok: true,
            message: confirmationResult.prompt,
            assistant_prompt: confirmationResult.prompt,
            booking_outcome: "confirmed",
            booking_state: bookingState,
            next_required_step: null,
          };
        }

        if (confirmationResult.kind === "pass_through") {
          const bookingState = buildRealtimeBookingState({
            steps,
            state: confirmationResult.state,
            explicitCurrentIndex: currentIndex,
          });

          return {
            ok: false,
            error: "INVALID_CONFIRMATION_STEP",
            message: "Confirmation step could not be processed.",
            booking_state: bookingState,
            next_required_step: buildNextRequiredStep({
              steps,
              bookingState,
              locale: bookingContext.currentLocale,
            }),
          };
        }
      } else {
        const normalizedStepValue = canonicalizeGenericStepValue(currentStep, value);
        const optionCandidates = extractStepOptionCandidates(currentStep);
        const hasConfiguredOptions = optionCandidates.length > 0;

        if (hasConfiguredOptions) {
          const resolvedToConfiguredOption = optionCandidates.some(
            (option) =>
              normalizeComparable(option.canonical) ===
              normalizeComparable(normalizedStepValue)
          );

          if (!resolvedToConfiguredOption) {
            const bookingState = buildRealtimeBookingState({
              steps,
              state: workingState,
              explicitCurrentIndex: currentIndex,
            });

            return {
              ok: false,
              error: "UNRESOLVED_STEP_OPTION",
              message:
                "The requested value could not be resolved to a configured canonical option.",
              booking_state: bookingState,
              next_required_step: buildNextRequiredStep({
                steps,
                bookingState,
                locale: bookingContext.currentLocale,
              }),
            };
          }
        }

        const nextAnswers = {
          ...rawAnswers,
          [targetSlot]: normalizedStepValue,
          [stepKey]: normalizedStepValue,
        };

        workingState = buildCanonicalCallState({
          state: workingState,
          answersBySlot: nextAnswers,
          bookingStepIndex: currentIndex,
        });
      }

      const nextIndex = getNextStepIndex(steps, currentIndex);

      const advancedState: CallState = {
        ...workingState,
        bookingStepIndex:
          typeof nextIndex === "number" ? nextIndex : undefined,
      };

      await persistVoiceState({
        tenantId,
        callSid: bookingContext.callSid,
        state: advancedState,
        locale: bookingContext.currentLocale,
      });

      const bookingState = buildRealtimeBookingState({
        steps,
        state: advancedState,
        explicitCurrentIndex: nextIndex,
      });

      return {
        ok: true,
        booking_state: bookingState,
        next_required_step: buildNextRequiredStep({
          steps,
          bookingState,
          locale: bookingContext.currentLocale,
        }),
        action_required: null,
      };
    }

    case "create_appointment": {
      if (!bookingContext) {
        return buildContextMissingResult();
      }

      const steps = sortFlowSteps(
        (await getBookingFlow(tenantId, "voice")) as BookingFlowStepLike[]
      );

      const confirmationStep = getConfirmationLikeStep(steps);

      if (!confirmationStep) {
        return {
          ok: false,
          error: "BOOKING_CONFIRMATION_STEP_NOT_FOUND",
          message: "No confirmation step is configured in the booking flow.",
        };
      }

      const currentIndex = getStepIndexByKey(
        steps,
        clean(confirmationStep.step_key)
      );

      const answersBySlot = normalizeAnswersToCanonicalSlots({
        steps,
        answersBySlot: buildAnswersBySlot({
          args,
          callerPhone,
          state: bookingContext.state,
        }),
      });

      const workingState = buildCanonicalCallState({
        state: bookingContext.state,
        answersBySlot,
        bookingStepIndex: currentIndex >= 0 ? currentIndex : undefined,
      });

      const confirmationResult = await executeCanonicalBookingConfirmationStep({
        tenant: bookingContext.tenant,
        cfg: bookingContext.cfg,
        flow: steps as any,
        currentStep: confirmationStep as any,
        currentLocale: bookingContext.currentLocale,
        callSid: bookingContext.callSid,
        didNumber: bookingContext.didNumber,
        callerE164: callerPhone,
        userInput: bookingContext.userInput,
        digits: bookingContext.digits,
        state: workingState,
        upsertVoiceCallState,
      });

      if (confirmationResult.kind === "busy_recovery") {
        const busyRecovered = await executeCanonicalBookingSlotBusyRecovery({
          flow: steps as any,
          state: confirmationResult.state,
          tenantId,
          callSid: bookingContext.callSid,
          currentLocale: bookingContext.currentLocale,
          callerE164: callerPhone,
          timeZone: confirmationResult.busyRecovery.timeZone,
          suggestedStarts: confirmationResult.busyRecovery.suggestedStarts,
        });

        const bookingState = buildRealtimeBookingState({
          steps,
          state: busyRecovered.state,
          explicitCurrentIndex: busyRecovered.datetimeStepIndex,
        });

        return {
          ok: false,
          error: "SLOT_UNAVAILABLE",
          message: busyRecovered.prompt,
          assistant_prompt: busyRecovered.prompt,
          suggested_times: parseJsonStringArray(
            busyRecovered.state.bookingData?.__booking_busy_suggested_starts
          ),
          booking_state: bookingState,
          next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: bookingContext.currentLocale,
            overridePrompt: busyRecovered.prompt,
          }),
        };
      }

      if (confirmationResult.kind === "retry") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex: currentIndex >= 0 ? currentIndex : null,
        });

        return {
          ok: false,
          error: "MISSING_FINAL_CONFIRMATION",
          message: confirmationResult.prompt,
          assistant_prompt: confirmationResult.prompt,
          booking_state: bookingState,
          next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: bookingContext.currentLocale,
            overridePrompt: confirmationResult.prompt,
          }),
        };
      }

      if (confirmationResult.kind === "failed") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex: null,
        });

        return {
          ok: false,
          error: "BOOKING_FAILED",
          message: confirmationResult.prompt,
          assistant_prompt: confirmationResult.prompt,
          booking_outcome: "failed",
          booking_state: bookingState,
          next_required_step: null,
        };
      }

      if (confirmationResult.kind === "cancelled") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex: null,
        });

        return {
          ok: true,
          message: confirmationResult.prompt,
          assistant_prompt: confirmationResult.prompt,
          booking_outcome: "cancelled",
          booking_state: bookingState,
          next_required_step: null,
        };
      }

      if (confirmationResult.kind === "awaiting_sms_destination") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex: null,
        });

        return {
          ok: true,
          booking_outcome: "awaiting_sms_destination",
          requires_sms_destination: true,
          booking_state: bookingState,
          next_required_step: null,
        };
      }

      if (confirmationResult.kind === "success_offer_sms") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex:
            typeof confirmationResult.state.bookingStepIndex === "number"
              ? confirmationResult.state.bookingStepIndex
              : null,
        });

        return {
          ok: true,
          message: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
          assistant_prompt: `${confirmationResult.successPrompt} ${confirmationResult.smsOfferPrompt}`,
          booking_outcome: "confirmed_offer_sms",
          booking_state: bookingState,
          next_required_step: buildNextRequiredStep({
            steps,
            bookingState,
            locale: bookingContext.currentLocale,
            overridePrompt: confirmationResult.smsOfferPrompt,
          }),
        };
      }

      if (confirmationResult.kind === "success") {
        const bookingState = buildRealtimeBookingState({
          steps,
          state: confirmationResult.state,
          explicitCurrentIndex: null,
        });

        return {
          ok: true,
          message: confirmationResult.prompt,
          assistant_prompt: confirmationResult.prompt,
          booking_outcome: "confirmed",
          booking_state: bookingState,
          next_required_step: null,
        };
      }

      return {
        ok: false,
        error: "CREATE_APPOINTMENT_NOT_ALLOWED",
        message: "The appointment could not be created in the current booking state.",
      };
    }

    case "end_call": {
      return {
        ok: true,
        hangup: true,
      };
    }

    default:
      return {
        ok: false,
        error: "UNKNOWN_TOOL",
        message: `Unknown realtime tool: ${toolName}`,
      };
  }
}