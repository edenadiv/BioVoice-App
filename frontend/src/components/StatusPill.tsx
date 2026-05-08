import type { Decision } from "../types";

type StatusPillProps = {
  decision: Decision;
};

const labelMap: Record<Decision, string> = {
  ACCEPT: "Verified",
  REJECT: "Rejected",
  DEEPFAKE: "Spoof flagged",
  PENDING: "Pending",
};

export function StatusPill({ decision }: StatusPillProps) {
  return <span className={`pill pill-${decision.toLowerCase()}`}>{labelMap[decision]}</span>;
}

