import type { Source } from "../../services/video/local-project";

export type AudioEdit = { sources: Source[]; names: string };

function nameCount(source: Source) {
  return 1 + source.markers.split(",").filter((value) => value.trim()).length;
}

export function versionRows({ sources, names }: AudioEdit) {
  const rows = names === "" ? [] : names.replace(/\r\n?/g, "\n").split("\n");
  const byId = new Map<string, string[]>();
  let offset = 0;
  for (const source of sources) {
    const count = nameCount(source);
    byId.set(source.id, rows.slice(offset, offset + count));
    offset += count;
  }
  return { byId, unassigned: rows.slice(offset) };
}

export function reorderAudio(edit: AudioEdit, id: string, direction: -1 | 1) {
  const index = edit.sources.findIndex((source) => source.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= edit.sources.length) return edit;
  const sources = [...edit.sources];
  [sources[index], sources[next]] = [sources[next], sources[index]];
  return withAudioOrder(edit, sources);
}

export function withAudioOrder(edit: AudioEdit, sources: Source[]): AudioEdit {
  const { byId, unassigned } = versionRows(edit);
  const rows = sources.flatMap((source) => {
    const assigned =
      byId.get(source.id) ?? unassigned.splice(0, nameCount(source));
    return Array.from({ length: nameCount(source) }, (_, i) => assigned[i]);
  });
  rows.push(...unassigned);
  while (rows.length && rows.at(-1) === undefined) rows.pop();
  return { sources, names: rows.join("\n") };
}

export function updateAudio(
  edit: AudioEdit,
  id: string,
  value: Partial<Source>,
): AudioEdit {
  const source = edit.sources.find((item) => item.id === id);
  if (!source) return edit;
  const updated = { ...source, ...value };
  const sources = edit.sources.map((item) => (item.id === id ? updated : item));
  const oldCount = nameCount(source);
  const newCount = nameCount(updated);
  if (oldCount === newCount || edit.sources.length === 1)
    return { ...edit, sources };

  const { byId, unassigned } = versionRows(edit);
  const rows = sources.flatMap((item) => {
    const assigned = byId.get(item.id)!;
    if (item.id === id && newCount < oldCount)
      unassigned.unshift(...assigned.slice(newCount));
    return Array.from({ length: nameCount(item) }, (_, i) => assigned[i]);
  });
  rows.push(...unassigned);
  while (rows.length && rows.at(-1) === undefined) rows.pop();
  return { sources, names: rows.join("\n") };
}

export function exportNames(songTitle: string, names: string) {
  const title = songTitle.trim();
  if (!title) return names;
  return names
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((version) =>
      version.trim() ? `${title} ${version.trim()}` : version,
    )
    .join("\n");
}
