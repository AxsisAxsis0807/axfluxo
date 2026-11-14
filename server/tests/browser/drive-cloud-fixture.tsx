import { createRoot } from "react-dom/client";
import DriveCloudPanel from "../../../src/features/developer/DriveCloudPanel";
import type { LocalProjectData } from "../../../src/services/video/local-project";
const mode = location.search.includes("fnf") ? "fnf-showcase" : "all-versions";
const project: LocalProjectData = {
  id: "11111111-1111-4111-8111-111111111111",
  mode,
  sources: [
    {
      id: "source",
      file: new File(["video-fixture"], "source.mp4", { type: "video/mp4" }),
      url: "blob:private-local-only",
      duration: 1,
      width: 160,
      height: 90,
      start: 0,
      end: 1,
      markers: "",
    },
  ],
  cover: "blob:cover",
  coverId: "cover",
  coverFile: new File(["image-fixture"], "cover.png", { type: "image/png" }),
  names: "NORMAL",
  ranges: [{ id: "range", start: 0, end: 1, name: "Hard" }],
  username: "@tester",
  scaleFactor: 1,
  cropTop: 0,
  cropBottom: 0,
};
createRoot(document.getElementById("root")!).render(
  <DriveCloudPanel project={project} />,
);
