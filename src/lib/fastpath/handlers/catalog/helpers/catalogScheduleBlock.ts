// src/lib/fastpath/handlers/catalog/helpers/catalogScheduleBlock.ts

import { extractSchedulesOnly } from "../../../helpers/extractSchedulesOnly";
import { withSectionTitle } from "./catalogReplyBlocks";

export function buildScheduleBlock(input: {
  idiomaDestino: string;
  infoClave?: string | null;
}): string {
  const schedulesOnly = extractSchedulesOnly(input.infoClave);

  return withSectionTitle(
    input.idiomaDestino,
    "Horarios:",
    "Schedules:",
    schedulesOnly
  );
}