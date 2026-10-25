export const WORKFLOW_LIMITS = {
  nodes: 200,
  edges: 1000,
  history: 100,
  debounce: 750,
  maxWait: 5000,
  recovery: 5,
  minZoom: 0.25,
  maxZoom: 2,
} as const;
export const WORKFLOW_ENABLED =
  process.env.NEXT_PUBLIC_WORKFLOW_ENABLED !== "false";

export const WORKFLOW_FIRST_ENABLED =
  WORKFLOW_ENABLED &&
  process.env.NEXT_PUBLIC_WORKFLOW_FIRST_ENABLED !== "false";
