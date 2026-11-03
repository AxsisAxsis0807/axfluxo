"use client";
import dynamic from "next/dynamic";
import LocalDeveloperGate from "../../../features/developer/LocalDeveloperGate";
const Studio = dynamic(
  () => import("../../../features/developer/DeveloperStudio"),
  { ssr: false },
);
export default function Page() {
  return (
    <LocalDeveloperGate>
      <Studio />
    </LocalDeveloperGate>
  );
}
