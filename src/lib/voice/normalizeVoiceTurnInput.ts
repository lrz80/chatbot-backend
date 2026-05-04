//src/lib/voice/normalizeVoiceTurnInput.ts
export type NormalizedVoiceTurnInput =
  | {
      text: string;
      digits: "";
      source: "speech";
    }
  | {
      text: "";
      digits: string;
      source: "digits";
    }
  | {
      text: "";
      digits: "";
      source: "empty";
    };

type NormalizeVoiceTurnInputParams = {
  speech?: string | null;
  digits?: string | null;
};

export function normalizeVoiceTurnInput(
  params: NormalizeVoiceTurnInputParams
): NormalizedVoiceTurnInput {
  const speech = String(params.speech || "").trim();
  const digits = String(params.digits || "").trim();

  if (speech.length > 0) {
    return {
      text: speech,
      digits: "",
      source: "speech",
    };
  }

  if (digits.length > 0) {
    return {
      text: "",
      digits,
      source: "digits",
    };
  }

  return {
    text: "",
    digits: "",
    source: "empty",
  };
}