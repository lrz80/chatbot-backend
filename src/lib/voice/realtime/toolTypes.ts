// src/lib/voice/realtime/toolTypes.ts

export type RealtimeToolResult = {
  ok?: boolean;
  error?: string;
  message?: string;
  response_message?: string;
  instructions?: string;
  missing_required_slots?: unknown;
  next_required_step?:
    | {
        step_key?: string;
        prompt?: string;
        retry_prompt?: string;
        unavailable_prompt?: string;
        required?: boolean;
        [key: string]: unknown;
      }
    | null;
  action_required?: string;
  unavailable_prompt?: string;
  retry_prompt?: string;
  [key: string]: unknown;
};