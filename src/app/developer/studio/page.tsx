"use client";
import dynamic from "next/dynamic";
import { DeveloperGate } from "../../../features/developer/DeveloperAccess";
const Studio = dynamic(
  () => import("../../../features/developer/DeveloperStudio"),
  { ssr: false },
);
export default function Page() {
  return <DeveloperGate>{() => <Studio />}</DeveloperGate>;
}
