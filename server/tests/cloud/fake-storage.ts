import { createHash, randomUUID } from "node:crypto";
import type { MultipartStorage, StoredPart } from "../../storage/multipart";
export class FakeStorage implements MultipartStorage {
  uploads = new Map<string, { key: string; parts: Map<number, Uint8Array> }>();
  objects = new Map<string, Uint8Array>();
  completed = 0;
  aborted = 0;
  loseCompleteResponse = false;
  async findUploads(key: string) {
    return Array.from(this.uploads)
      .filter(([, u]) => u.key === key)
      .map(([id]) => id);
  }
  async create(key: string) {
    const id = randomUUID();
    this.uploads.set(id, { key, parts: new Map() });
    return id;
  }
  async signPart(_key: string, id: string, number: number, md5: string) {
    return {
      url: `https://storage.test/${id}/${number}`,
      headers: { "Content-MD5": Buffer.from(md5, "hex").toString("base64") },
      expiresAt: Date.now() + 300000,
    };
  }
  put(id: string, number: number, bytes: Uint8Array) {
    this.uploads.get(id)!.parts.set(number, bytes);
    return '"' + createHash("md5").update(bytes).digest("hex") + '"';
  }
  async parts(_key: string, id: string): Promise<StoredPart[]> {
    return Array.from(this.uploads.get(id)?.parts ?? []).map(
      ([number, bytes]) => ({
        number,
        size: bytes.length,
        etag: '"' + createHash("md5").update(bytes).digest("hex") + '"',
      }),
    );
  }
  async head(key: string) {
    return this.objects.has(key)
      ? { size: this.objects.get(key)!.length }
      : null;
  }
  async complete(key: string, id: string, parts: StoredPart[]) {
    this.completed++;
    this.objects.set(
      key,
      Buffer.concat(
        parts.map((p) => this.uploads.get(id)!.parts.get(p.number)!),
      ),
    );
    this.uploads.delete(id);
    if (this.loseCompleteResponse) {
      this.loseCompleteResponse = false;
      throw new Error("lost response with private signed URL");
    }
  }
  async abort(_key: string, id: string) {
    this.aborted++;
    this.uploads.delete(id);
  }
  async stream(key: string) {
    const bytes = this.objects.get(key)!;
    return (async function* () {
      for (let i = 0; i < bytes.length; i += 65536)
        yield bytes.subarray(i, i + 65536);
    })();
  }
  async access(key: string) {
    return {
      url: `https://storage.test/access/${encodeURIComponent(key)}`,
      expiresAt: Date.now() + 60000,
    };
  }
}
