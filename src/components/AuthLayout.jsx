import React from "react";

export default function AuthLayout({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-panel/70 p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          {Icon && (
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Icon className="h-6 w-6" aria-hidden="true" />
            </div>
          )}
          {title && <h1 className="font-heading text-xl font-semibold">{title}</h1>}
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
