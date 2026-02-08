export type Lang = "es" | "en";

export type CatalogNeed = "price" | "includes" | "duration" | "link" | "list" | "any";

export type LastServiceRef = {
  kind: "service" | "variant" | null;
  label: string | null;
  service_id: string | null;
  variant_id?: string | null;
  saved_at: string;
};

export type CatalogFacts = {
  kind: "service" | "variant";
  label: string;

  service_id: string;
  variant_id?: string | null;

  price: number | null;
  currency: string | null;

  duration_min: number | null;
  description: string | null;

  url: string | null;

  // si hay variantes y falta elegir
  variants?: Array<{
    variant_id: string;
    variant_name: string;
    price: number | null;
    currency: string | null;
    url: string | null;
  }>;
};

export type CatalogResult =
  | {
      hit: true;
      status: "resolved";
      need: CatalogNeed;
      facts: CatalogFacts;
      ctxPatch: { last_service_ref: LastServiceRef };
    }
  | {
      hit: true;
      status: "needs_clarification";
      need: CatalogNeed;
      ask: string; // 1 pregunta corta
      options?: Array<{ label: string; service_id: string; variant_id?: string | null; kind: "service" | "variant" }>;
      ctxPatch?: any; // opcional si quieres persistir options para picks
    }
  | {
      hit: true;
      status: "no_match";
      need: CatalogNeed;
      ask: string;
    }
  | {
      hit: false;
    };
