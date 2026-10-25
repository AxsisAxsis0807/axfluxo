import { get, type Asset } from "../storage";

/** Resolves a ProjectDocument UUID without binding the renderer to a database. */
export type ResolvedAsset = Pick<Asset, "blob" | "width" | "height">;
export type AssetResolver = (
  assetId: string,
) => Promise<ResolvedAsset | undefined>;

/** Compatibility default for existing Studio projects and backups. */
export const legacyAssetResolver: AssetResolver = (id) =>
  get<Asset>("assets", id);
