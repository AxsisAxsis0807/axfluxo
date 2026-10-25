import { createContext } from "react";
export const EditorDraftContext = createContext<
  ((id: string, pending: boolean) => void) | undefined
>(undefined);
