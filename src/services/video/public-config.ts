/** Next inlines configured public values; standalone/embedded browser builds safely default OFF. */
export function driveCloudUiEnabled() {
  try {
    return process.env.NEXT_PUBLIC_DRIVE_CLOUD_UI === "true";
  } catch {
    return false;
  }
}
export function publicVideoOrigin() {
  try {
    return process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
  } catch {
    return undefined;
  }
}

export function publicBasePath() {
  try {
    return process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  } catch {
    return "";
  }
}
