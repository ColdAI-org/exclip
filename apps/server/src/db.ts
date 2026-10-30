/** The part of a pg Pool the Postgres stores use. A pg.Pool fits; tests hand the stores a fake that records queries,
 * so the stores' statements and transactions can be checked without a database. */
export type SqlResult = { rows: Array<Record<string, unknown>>; rowCount: number | null };
export type SqlClient = {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  /** true destroys the connection instead of returning it to the pool. */
  release(destroy?: boolean): void;
};
export type SqlPool = {
  query(text: string, values?: unknown[]): Promise<SqlResult>;
  connect(): Promise<SqlClient>;
};

/** Runs `work` in one transaction on one connection: COMMIT when it resolves, ROLLBACK when it throws. */
export async function transaction<T>(pool: SqlPool, work: (client: SqlClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let healthy = true;
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A connection whose ROLLBACK failed is in an unknown state: it is dropped, not handed to the next request.
    await client.query("ROLLBACK").catch(() => { healthy = false; });
    throw error;
  } finally {
    client.release(!healthy);
  }
}
