import type { ReactNode } from "react";

// Header of one Copilot page section, in the style of the Integrations panes.
export function PaneHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <div className="min-w-0 flex-1 basis-60">
        <h2 tabIndex={-1} className="text-base text-foreground outline-none">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
    </div>
  );
}

// A titled block inside a section.
export function Block({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <div>
        <h3 className="text-xs font-semibold tracking-tight text-foreground">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}
