"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4">
      <h2 className="text-2xl font-bold">Not Found</h2>
      <p className="text-muted-foreground">The page you're looking for doesn't exist.</p>
      <Link href="/" className="text-primary underline">
        Go home
      </Link>
    </div>
  );
}
