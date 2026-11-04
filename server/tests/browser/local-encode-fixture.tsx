import { LOCK_KEY } from "../../../src/services/developer/local-lock";
import React from "react";
import { createRoot } from "react-dom/client";
import { LocalExport } from "../../../src/features/video-common/LocalExport";
import ExportDock from "../../../src/features/video-common/ExportDock";
import {
  SESSION_KEY,
  UNLOCK_MS,
} from "../../../src/services/developer/local-lock";
localStorage.setItem(
  LOCK_KEY,
  JSON.stringify({ salt: "a".repeat(32), hash: "b".repeat(64) }),
);
sessionStorage.setItem(SESSION_KEY, String(Date.now() + UNLOCK_MS));
createRoot(document.getElementById("root")!).render(
  <>
    <LocalExport
      disabled={false}
      prepare={async () => [
        {
          filename: "encoded.mp4",
          width: 320,
          height: 180,
          pieces: [
            {
              url: async () => "https://encode.test/source.mp4",
              start: 0.2,
              end: 0.7,
            },
            {
              url: async () => "https://encode.test/source.mp4",
              start: 0.1,
              end: 0.6,
            },
          ],
          draw: (ctx, media) => ctx.drawImage(media, 0, 0, 320, 180),
        },
      ]}
    />
    <ExportDock />
  </>,
);
