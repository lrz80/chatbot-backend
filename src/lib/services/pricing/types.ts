export type Lang2 = "es" | "en";

export type PriceOption = {
  label: string;
  amount: number;
  currency: string;
};

export type PriceInfo =
  | { ok: true; mode: "fixed"; amount: number; currency: string }
  | {
      ok: true;
      mode: "from";
      amount: number;
      currency: string;
      options?: PriceOption[];
      optionsCount?: number;
    }
  | { ok: false; reason: "no_price" };

export type PriceContext = {
  serviceName: string | null;
  mode: "fixed" | "from";
  amount: number;
  currency: string;
  options?: PriceOption[];
  optionsCount?: number;
};
