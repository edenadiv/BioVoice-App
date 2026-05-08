import type { ReactNode } from "react";

type AppWindowProps = {
  title: string;
  children: ReactNode;
  className?: string;
};

export function AppWindow({ title, children, className }: AppWindowProps) {
  const bodyClassName = ["bv-window-body", className].filter(Boolean).join(" ");
  return (
    <div className="bv-stage">
      <section className="bv-window" role="application" aria-label={title}>
        <header className="bv-titlebar">
          <span className="bv-traffic" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="bv-titlebar-title">{title}</span>
          <span aria-hidden="true" />
        </header>
        <div className={bodyClassName}>{children}</div>
      </section>
    </div>
  );
}
