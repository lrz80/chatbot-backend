function stripAccents(s: string) {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function norm(s: string) {
  return stripAccents(String(s || "").toLowerCase())
    .replace(/[^a-z0-9ñ\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string) {
  const t = norm(s);
  if (!t) return [];
  return t.split(" ").filter(Boolean);
}

const STOP = new Set([
  // ES
  "el","la","los","las","de","del","un","una","unos","unas","para","por","que",
  "quiero","necesito","dame","mas","info","informacion","detalles",
  "precio","precios","cuanto","cuesta","vale","tarifa","tarifas",
  // EN
  "the","a","an","to","for","and","or","of","in","on","is","are",
  "price","prices","cost","costs","how","much","rate","rates","fee","fees","pricing",
]);

function contentTokens(text: string) {
  return tokenize(text).filter((w) => w.length >= 2 && !STOP.has(w));
}

function diceCoefficient(a: string, b: string) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };

  const A = bigrams(a);
  const B = bigrams(b);

  const map = new Map<string, number>();
  for (const x of A) map.set(x, (map.get(x) || 0) + 1);

  let inter = 0;
  for (const x of B) {
    const n = map.get(x) || 0;
    if (n > 0) {
      inter++;
      map.set(x, n - 1);
    }
  }

  return (2 * inter) / (A.length + B.length);
}

export function scoreCandidate(query: string, label: string) {
  const qn = norm(query);
  const ln = norm(label);

  const qTokens = contentTokens(query);
  if (!qTokens.length) return 0;

  const lTokens = new Set(contentTokens(label));

  let overlap = 0;
  for (const tok of qTokens) if (lTokens.has(tok)) overlap++;

  const substr = ln.includes(qn) || qn.includes(ln) ? 2 : 0;

  const fuzzy = diceCoefficient(qn, ln) * 3; // 0..3

  let prefix = 0;
  for (const tok of qTokens) {
    if (tok.length >= 3) {
      for (const lt of lTokens) {
        if (lt.startsWith(tok) || tok.startsWith(lt)) {
          prefix += 0.3;
          break;
        }
      }
    }
  }

  return overlap * 3 + substr + fuzzy + prefix;
}
