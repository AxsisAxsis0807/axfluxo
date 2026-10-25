import {
  all,
  saveProject,
  put,
  type Asset,
  type Template,
} from "../../services/storage";
import type { ProjectDocument } from "../../domain/document";
import { backup, restore } from "../../services/backup";
import { legacyAssetResolver } from "../../services/editor/asset-resolver";

/** Existing Studio persistence only. This adapter never writes workspace data
 * or converts an existing project into a workflow document. */
export const legacyStudioAdapter = {
  assetResolver: legacyAssetResolver,
  saveDocument: saveProject,
  backup,
  restore,
  storeAsset: (asset: Asset) => put("assets", asset),
  async loadLibrary() {
    const [projects, assets, templates] = await Promise.all([
      all<ProjectDocument>("projects"),
      all<Asset>("assets"),
      all<Template & { templateId?: string }>("templates"),
    ]);
    return {
      projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      assets,
      templates,
    };
  },
};
