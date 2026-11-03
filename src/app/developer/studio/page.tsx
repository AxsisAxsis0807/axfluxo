"use client";
import dynamic from "next/dynamic";
import { DeveloperGate } from "../../../features/developer/DeveloperAccess";
const Studio = dynamic(
  () => import("../../../features/developer/OutputLibrary"),
  { ssr: false },
);
export default function Page() {
  return <DeveloperGate>{(api) => <Studio api={api} />}</DeveloperGate>;
}
