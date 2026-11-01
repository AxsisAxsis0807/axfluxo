export type StoredPart = { number: number; size: number; etag: string };
export interface MultipartStorage {
  findUploads(key: string): Promise<string[]>;
  create(key: string, owner: string, session: string): Promise<string>;
  signPart(
    key: string,
    id: string,
    number: number,
    md5: string,
  ): Promise<{
    url: string;
    headers: Record<string, string>;
    expiresAt: number;
  }>;
  parts(key: string, id: string): Promise<StoredPart[]>;
  head(key: string): Promise<{ size: number } | null>;
  complete(key: string, id: string, parts: StoredPart[]): Promise<void>;
  abort(key: string, id: string): Promise<void>;
  stream(key: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  access(
    key: string,
    mime: string,
    name: string,
  ): Promise<{ url: string; expiresAt: number }>;
}
