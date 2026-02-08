export type Lang = "es" | "en";

export type CatalogNeed = "price" | "includes" | "duration" | "link" | "list" | "any";

export type LastServiceRef = {
  kind: "service" | "variant" | null;
  label: string | null;
  service_id: string | null;
  variant_id?: string | null;
  saved_at: string;
};

export type CatalogOptionItem =
  | {
      kind: "service";
      service_id: string;
      label: string;
      price: number | null;
      currency: string;
      duration_min: number | null;
      url: string | null;
      variants_count?: number;
    }
  | {
      kind: "variant";
      service_id: string;
      variant_id: string;
      label: string;
      price: number | null;
      currency: string;
      duration_min: number | null;
      url: string | null;
    };

export type CatalogFacts =
  | {
      kind: "service";
      label: string;
      service_id: string;
      variant_id: null;
      price: number | null;
      currency: string;
      duration_min: number | null;
      description: string | null;
      url: string | null;
    }
  | {
      kind: "variant";
      label: string;
      service_id: string;
      variant_id: string;
      price: number | null;
      currency: string;
      duration_min: number | null;
      description: string | null;
      url: string | null;
    }
  | {
      kind: "options";
      label: string;              // ej: nombre del servicio o "CATALOG_OPTIONS"
      service_id?: string;        // opcional si es lista global
      options: CatalogOptionItem[];
    };

export type CatalogResult =
  | { hit: false }
  | {
      hit: true;
      status: "resolved";
      need: CatalogNeed;
      facts: CatalogFacts;
      ctxPatch?: { last_service_ref?: LastServiceRef }; // ✅ opcional
    }
  | {
      hit: true;
      status: "needs_clarification";
      need: CatalogNeed;
      ask: string;
      options?: any[];
      ctxPatch?: { last_service_ref?: LastServiceRef }; // ✅ opcional también
    }
  | {
      hit: true;
      status: "no_match";
      need: CatalogNeed;
      ask: string;
      ctxPatch?: { last_service_ref?: LastServiceRef }; // ✅ opcional
    };
;
