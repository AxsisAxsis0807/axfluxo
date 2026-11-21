import type { StorageRole } from "../../src/domain/storage/destinations";
import type { StoredPart } from "./multipart";

export type StorageReference<Provider extends string = string> = {
  provider: Provider;
  location: string;
  key: string;
};

export type SignedStorageAccess = { url: string; expiresAt: number };

/** A provider is bound to one immutable account/location. Resolve the reference before I/O. */
export interface StorageProvider<Provider extends string = string> {
  readonly location: string;
  newReference(
    role: StorageRole,
    owner: string,
    projectId: string | null,
    filename: string,
  ): StorageReference<Provider>;
  head(
    ref: StorageReference<Provider>,
    signal?: AbortSignal,
  ): Promise<{ size: number } | null>;
  stream(
    ref: StorageReference<Provider>,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<AsyncIterable<Uint8Array>>;
  sign?(
    ref: StorageReference<Provider>,
    operation: "GET",
  ): Promise<SignedStorageAccess>;
}

/** Implement only for providers able to reconcile and abort resumable uploads. */
export interface MultipartStorageProvider<
  Provider extends string = string,
> extends StorageProvider<Provider> {
  create(
    ref: StorageReference<Provider>,
    signal?: AbortSignal,
  ): Promise<string>;
  findUploads(
    ref: StorageReference<Provider>,
    signal?: AbortSignal,
  ): Promise<string[]>;
  parts(
    ref: StorageReference<Provider>,
    id: string,
    signal?: AbortSignal,
  ): Promise<StoredPart[]>;
  sign(
    ref: StorageReference<Provider>,
    operation: "GET",
  ): Promise<SignedStorageAccess>;
  sign(
    ref: StorageReference<Provider>,
    operation: "PART",
    part: { id: string; number: number; size: number },
  ): Promise<SignedStorageAccess>;
  complete(
    ref: StorageReference<Provider>,
    id: string,
    parts: StoredPart[],
    signal?: AbortSignal,
  ): Promise<void>;
  abort(
    ref: StorageReference<Provider>,
    id: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type StoragePolicy = {
  readonly maxFileBytes: number | null;
  readonly multipartWrites: boolean;
  readonly capacityMaxAgeMs: number;
};
