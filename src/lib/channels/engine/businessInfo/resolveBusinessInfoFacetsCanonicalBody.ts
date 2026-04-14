// src/lib/channels/engine/businessInfo/resolveBusinessInfoFacetsCanonicalBody.ts
import type { Pool } from "pg";
import type { Canal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { withSectionTitle } from "../../../fastpath/handlers/catalog/helpers/catalogReplyBlocks";
import {
  buildAvailabilityBlockFromInfoClave,
  buildLocationBlockFromInfoClave,
} from "../../../fastpath/handlers/catalog/helpers/catalogBusinessInfoBlocks";
import { buildScheduleBlock } from "../../../fastpath/handlers/catalog/helpers/catalogScheduleBlock";
import {
  resolveBusinessInfoFacetTargets,
  type BusinessInfoScheduleTarget,
} from "./resolveBusinessInfoFacetTargets";

type Args = {
  pool: Pool;
  tenantId: string;
  canal: Canal;
  idiomaDestino: LangCode;
  userInput: string;
  promptBaseMem: string;
  infoClave: string;
  facets: {
    asksSchedules?: boolean;
    asksLocation?: boolean;
    asksAvailability?: boolean;
  };
};

export async function resolveBusinessInfoFacetsCanonicalBody(
  args: Args
): Promise<string> {
  const { pool, tenantId, idiomaDestino, infoClave, facets, userInput } = args;

  const shouldResolveBusinessInfo =
    facets.asksSchedules === true ||
    facets.asksLocation === true ||
    facets.asksAvailability === true;

  if (!shouldResolveBusinessInfo) {
    return "";
  }

  const facetTargets = await resolveBusinessInfoFacetTargets({
    pool,
    tenantId,
    userInput,
    facets,
  });

  const blocks: string[] = [];

  if (facets.asksSchedules === true) {
    const scheduleBlock = buildScheduleBlock({
      idiomaDestino,
      infoClave,
      scheduleTarget: facetTargets.scheduleTarget as BusinessInfoScheduleTarget,
    });

    if (String(scheduleBlock || "").trim()) {
      blocks.push(String(scheduleBlock).trim());
    }
  }

  if (facets.asksLocation === true) {
    const locationBody = buildLocationBlockFromInfoClave(infoClave);

    const locationBlock = withSectionTitle(
      idiomaDestino,
      "Ubicación:",
      "Location:",
      locationBody
    );

    if (String(locationBlock || "").trim()) {
      blocks.push(String(locationBlock).trim());
    }
  }

  if (facets.asksAvailability === true) {
    const availabilityBody = buildAvailabilityBlockFromInfoClave(infoClave);

    const availabilityBlock = withSectionTitle(
      idiomaDestino,
      "Disponibilidad:",
      "Availability:",
      availabilityBody
    );

    if (String(availabilityBlock || "").trim()) {
      blocks.push(String(availabilityBlock).trim());
    }
  }

  return blocks.join("\n\n").trim();
}