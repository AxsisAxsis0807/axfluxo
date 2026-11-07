# All Versions timeline / Safari investigation

The local editor (`LocalVideoTool` / `LocalTimeline`) owns the reported central
playhead and Smart Track Boundary Detection UI. Confirmed Version boundaries
remain in the existing comma-separated `Source.markers` field; no IndexedDB
schema or project format migration is needed. Old manual candidates remain
stored separately and can be applied after reanalysis. Analysis v1 results are
retained on disk but require reanalysis under algorithm v2.

## Boundary detection findings

`TrackFeatures.activity` previously clipped a requested three-second context to
available frames and accepted as little as 0.5 seconds. This allowed a short tail
restart to qualify without the intended context. Both activity windows must now
exist in full. This is an evidence requirement, not a blanket cutoff measured
from the video end. Real gaps close to EOF remain detectable with full context.
Candidates outside the current trim are hidden and cannot be applied. Analysis
never writes confirmed markers. Applying a candidate in All Versions adds a
marker without moving the selected marker or a trim handle.

PCM times remain source timestamps plus sample index / decoded sample rate;
packet overlap is excluded by `freshStart`, and partial final hops keep their
actual sample counts. Missing PCM is an analysis error, not synthesized silence.
Audio shorter than the container can therefore fail analysis safely. Such a
failure preserves edits and needs no synthetic EOF candidate.

## Memory and lifecycle findings

- Existing audio decoding is serialized and chunked (4-second compressed chunks,
  4 MiB packet limit); no full-media `decodeAudioData` is used here.
- Waveform publish previously copied up to 40,000 peak values for **every decoded
  buffer**, even when the 200ms UI publication throttle discarded the snapshot.
  Copies now happen only at publication time.
- Project writes previously queued every cursor/edit snapshot. Writes now retain
  one active and one latest pending snapshot per project, sharing its completion
  promise. Existing staged asset chunks, checksums, atomic metadata publication,
  leases, and restore-error handling are preserved. Saving does not reread assets
  whose manifest already exists.
- Track detection now aborts its worker/decoder on backgrounding, and suspends
  fine waveform decoding while detection runs. Existing waveform cancellation,
  bounded detail cache (four windows), input disposal, and AudioContext.close
  remain in place. Shared cloud preview releases its media source on cleanup.

## Limits and device reproduction

These findings identify allocation pressure and missing lifecycle handling;
they do **not** prove the cause of the reported iPhone tab reload. Desktop
Playwright WebKit is not an iOS device memory-pressure test.

On a physical iPhone record model, iOS/Safari version, source codec/resolution/
duration/size, number of sources, zoom, and foreground/background transitions.
Compare 30+ minutes of editing with waveform/detection enabled and cancelled,
and verify saved boundaries, names, trim and display state after reopening.
Use Safari remote inspector's timeline/memory tools and device WebKit/jetsam
logs to correlate process termination and memory usage. A `navigation` entry
with type `reload` can identify ordinary reload navigation, but alone cannot
establish or exclude an OS-recreated tab. A WebKit crash report identifies a
crash; jetsam reports identify OS memory termination. A missing unload event is
not proof of either. No on-device crash/jetsam evidence is available here.

A reload during a pending transaction can restore the last committed snapshot;
no browser can guarantee the latest uncommitted edit survives process death.
Restoration failures continue to block editing rather than overwrite saved data.
