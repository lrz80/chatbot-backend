import type { Canal } from "../../../detectarIntencion";
import type { LangCode } from "../../../i18n/lang";
import { resolveBusinessInfoOverviewCanonicalBody } from "./resolveBusinessInfoOverviewCanonicalBody";

type Args = {
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
  const { facets } = args;

  const shouldResolveBusinessInfo =
    facets.asksSchedules === true ||
    facets.asksLocation === true ||
    facets.asksAvailability === true;

  if (!shouldResolveBusinessInfo) {
    return "";
  }

  return await resolveBusinessInfoOverviewCanonicalBody({
    tenantId: args.tenantId,
    canal: args.canal,
    idiomaDestino: args.idiomaDestino,
    userInput: args.userInput,
    promptBaseMem: args.promptBaseMem,
    infoClave: args.infoClave,
    overviewMode: "general_overview",
  });
}