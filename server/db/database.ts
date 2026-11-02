export type Row = Record<string, unknown>;
export interface Sql {
  query<T extends Row = Row>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
}
