import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "success" | "danger" | "warn" | "secondary" | "ghost";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "md" | "lg";
  block?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function Button({
  variant = "primary",
  size = "md",
  block,
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes = [
    "bv-btn",
    `bv-btn--${variant}`,
    size === "lg" ? "bv-btn--lg" : null,
    block ? "bv-btn--block" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button {...rest} type={type} className={classes}>
      {leadingIcon}
      <span>{children}</span>
      {trailingIcon}
    </button>
  );
}
