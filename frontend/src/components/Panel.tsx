import type { ReactNode } from "react";

type PanelProps = {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  id?: string;
};

export function Panel({ title, subtitle, children, className = "", id }: PanelProps) {
  return (
    <section id={id} className={`panel ${className}`.trim()}>
      {(title || subtitle) && (
        <header className="panel-header">
          {title ? <h2>{title}</h2> : null}
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      )}
      {children}
    </section>
  );
}
