import { createRoot } from "react-dom/client";
import { useState } from "react";
import LocalTimeline from "../../../src/features/developer/LocalTimeline";
import { analyzeLocalWaveform } from "../../../src/services/video/local-waveform";
Object.assign(window, { analyzeLocalWaveform });
function Fixture() {
  const [files, setFiles] = useState<File[]>([]);
  const [end, setEnd] = useState(8);
  return (
    <>
      <input
        aria-label="files"
        type="file"
        multiple
        onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
      />
      <button onClick={() => setFiles([])}>remove</button>
      <output aria-label="edited">{end}</output>
      {files.map((file, i) => (
        <LocalTimeline
          key={`${file.name}-${i}`}
          file={file}
          duration={8}
          media={() => null}
          fnf={false}
          markers={[]}
          items={[
            { id: String(i), label: file.name, startUs: 0, endUs: end * 1e6 },
          ]}
          onEdit={(_, __, value) => setEnd(value)}
        />
      ))}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
