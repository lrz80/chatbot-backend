import { wantsHomeService } from "../detectors/wantsHomeService";

export function isNonCatalogQuestion(routingText: string) {
  // aquí vas agregando “cosas que NO son catálogo”
  // sin ensuciar handleServicesFastpath.ts

  if (wantsHomeService(routingText)) return true;

  return false;
}
