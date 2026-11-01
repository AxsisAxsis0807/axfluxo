import { createRoot } from "react-dom/client";
import { useRef, useState } from "react";
import { VideoPreview } from "../../../src/features/video-common/VideoPreview";
import {
  PlaybackError,
  type PreviewError,
} from "../../../src/services/video/playback";
import { saveVideoDocument } from "../../../src/services/video/document";
import type { AllVersionsDocument } from "../../../src/domain/video/schema";
const id = "11111111-1111-4111-8111-111111111111",
  asset = "22222222-2222-4222-8222-222222222222",
  hash = "a".repeat(64);
let failure: PreviewError | null = null,
  calls = 0;
Object.assign(window, {
  setPreviewFailure: (code: PreviewError | null) => {
    failure = code;
  },
});
const resolve = async () => {
  if (failure) throw new PlaybackError(failure);
  calls++;
  Object.assign(window, { previewResolveCalls: calls });
  return {
    versionId: id,
    assetId: asset,
    hash,
    durationUs: 3000000,
    width: 160,
    height: 90,
    mapping: {
      sourceFirstPtsUs: 0,
      proxyFirstPtsUs: 0,
      sourceTimeBase: "1/60000",
      proxyTimeBase: "1/1000000",
    },
    rate: { numerator: 60, denominator: 1 },
    rotationDegrees: 0,
    proxy: `https://preview-browser.test/media.mp4?ticket=${calls}`,
    thumbnail: "https://preview-browser.test/thumbnail.jpg",
    waveform: "https://preview-browser.test/wave.json",
    expiresAt: Date.now() + 60000,
  };
};
function Fixture() {
  const [mode, setMode] = useState<"all-versions" | "fnf">("all-versions"),
    [doc, setDoc] = useState<AllVersionsDocument>({
      schemaVersion: 1,
      kind: "all-versions",
      id: "fixture-preview",
      revision: 0,
      clips: [
        {
          id: "clip-a",
          source: {
            libraryId: "cloud",
            fileId: asset,
            versionId: id,
            hash,
            kind: "video",
          },
          sourceDurationUs: 3000000,
          interval: { startUs: 0, endUs: 3000000 },
          markersUs: [1000000],
        },
      ],
      fnf: { schemaVersion: 1, mode: "fnf", paddingUs: 0 },
    }),
    [saved, setSaved] = useState(0);
  const revision = useRef(0),
    queue = useRef(Promise.resolve());
  return (
    <>
      <label>
        fixture mode
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as typeof mode)}
        >
          <option value="all-versions">All Versions</option>
          <option value="fnf">FNF</option>
        </select>
      </label>
      <button
        onClick={() =>
          setDoc((old) => ({
            ...old,
            clips: [
              {
                ...old.clips[0],
                interval: { startUs: 0, endUs: 400000 },
                markersUs: [200000],
              },
              {
                ...old.clips[0],
                id: "clip-b",
                interval: { startUs: 1000000, endUs: 1400000 },
                markersUs: [],
              },
            ],
          }))
        }
      >
        fixture joined clips
      </button>
      <output data-testid="source-start">
        {doc.clips[0].interval.startUs}
      </output>
      <output data-testid="saved-count">{saved}</output>
      <VideoPreview
        key={mode}
        mode={mode}
        document={doc}
        resolve={resolve}
        onDocumentChange={(next) => {
          setDoc(next);
          queue.current = queue.current.then(async () => {
            const value = await saveVideoDocument({
              ...next,
              revision: revision.current,
            });
            revision.current = value.revision;
            setDoc(value);
            setSaved((n) => n + 1);
          });
        }}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
