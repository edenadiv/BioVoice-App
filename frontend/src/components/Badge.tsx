import type { ReactNode } from "react";

type BadgeTone = "success" | "danger" | "info" | "warn" | "neutral";

type BadgeProps = {
  tone?: BadgeTone;
  showDot?: boolean;
  leadingIcon?: ReactNode;
  children: ReactNode;
};

export function Badge({ tone = "neutral", showDot, leadingIcon, children }: BadgeProps) {
  return (
    <span className={`bv-badge bv-badge--${tone}`}>
      {showDot ? <span className="bv-badge__dot" aria-hidden="true" /> : null}
      {leadingIcon}
      <span>{children}</span>
    </span>
  );
}
