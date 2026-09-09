"use client";

import Button from "@/shared/components/Button";

export default function DashboardError({ error, reset }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <span className="material-symbols-outlined text-4xl text-red-500 mb-4">error</span>
      <h2 className="text-lg font-semibold text-text-main mb-2">Something went wrong</h2>
      <p className="text-sm text-text-muted mb-6 max-w-md break-words">
        {error?.message || "An unexpected error occurred."}
      </p>
      <Button onClick={reset} icon="refresh">
        Try again
      </Button>
    </div>
  );
}