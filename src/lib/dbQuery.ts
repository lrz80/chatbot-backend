import pool from "./db";

type QueryResult<T = any> = {
  rows: T[];
  rowCount: number | null;
};

export async function queryWithTimeout<T = any>(
  text: string,
  params: any[] = [],
  timeoutMs = Number(process.env.PG_QUERY_TIMEOUT_MS ?? 12_000)
): Promise<QueryResult<T>> {
  const startedAt = Date.now();

  try {
    const result = await Promise.race([
      pool.query(text, params),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error(`PG query timeout after ${timeoutMs}ms`));
        }, timeoutMs)
      ),
    ]);

    const elapsed = Date.now() - startedAt;

    if (elapsed > 3000) {
      console.warn("⚠️ PG query lenta", {
        ms: elapsed,
        text: text.slice(0, 120),
      });
    }

    return result as QueryResult<T>;
  } catch (error) {
    const elapsed = Date.now() - startedAt;

    console.error("❌ PG query failed", {
      ms: elapsed,
      text: text.slice(0, 120),
      error,
    });

    throw error;
  }
}