"use client";
import dynamic from "next/dynamic";
import { DeveloperGate } from "../../../features/developer/DeveloperAccess";
const LocalTool = dynamic(
  () => import("../../../features/developer/DeveloperTool"),
  { ssr: false },
);
export default function Page() {
  return (
    <DeveloperGate>
      {(access) => <LocalTool mode="fnf-showcase" ownerId={access.ownerId} />}
    </DeveloperGate>
  );
}
