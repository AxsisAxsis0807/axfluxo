"use client";
import dynamic from "next/dynamic";
import LocalDeveloperGate from "../../../features/developer/LocalDeveloperGate";
const LocalTool = dynamic(
  () => import("../../../features/developer/DeveloperTool"),
  { ssr: false },
);
export default function Page() {
  return (
    <LocalDeveloperGate>
      <LocalTool mode="fnf-showcase" ownerId="device-local" />
    </LocalDeveloperGate>
  );
}
