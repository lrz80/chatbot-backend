// src/lib/appointments/createAppointmentFromVoice.ts

import {
  createAppointment,
  type CreateAppointmentArgs,
} from "./createAppointment";

type CreateAppointmentFromVoiceArgs =
  Omit<CreateAppointmentArgs, "channel">;

export function createAppointmentFromVoice(
  args: CreateAppointmentFromVoiceArgs
) {
  return createAppointment({
    ...args,
    channel: "voice",
  });
}