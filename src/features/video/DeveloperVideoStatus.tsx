"use client";
import {
  videoStateMessage,
  type VideoState,
} from "../../services/video/api-client";
/** Host can mount this for developer tools; no public entry or auth-only UI gate is added. */
export function DeveloperVideoStatus({ state }: { state: VideoState }) {
  const error = [
    "unauthenticated",
    "auth-expired",
    "forbidden",
    "failed",
  ].includes(state);
  return (
    <p
      role={error ? "alert" : "status"}
      aria-live={error ? "assertive" : "polite"}
    >
      {videoStateMessage[state]}
    </p>
  );
}
