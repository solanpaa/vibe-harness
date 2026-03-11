export default function ReviewDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Review</h1>
      <p className="text-muted-foreground">
        AI summary, diff viewer with inline comments, and approve/request changes actions will appear here.
      </p>
    </div>
  );
}
