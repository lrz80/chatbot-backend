import type { Pool } from "pg";
import type { CatalogResult, Lang } from "./types";
import { detectCatalogNeed } from "./isCatalogQuestion";
import { resolveCatalogFromDb } from "./resolveCatalogFromDb";

export async function catalogBrain(args: {
  pool: Pool;
  tenantId: string;
  userInput: string;
  idiomaDestino: Lang;
  convoCtx: any;
}): Promise<CatalogResult> {
  const { pool, tenantId, userInput, idiomaDestino, convoCtx } = args;

  const need = detectCatalogNeed(userInput, idiomaDestino);
  if (!need) return { hit: false };

  return await resolveCatalogFromDb({
    pool,
    tenantId,
    userInput,
    need,
    idioma: idiomaDestino,
    lastRef: convoCtx?.last_service_ref,
  });
}
