export default function ReviewHistoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Review History</h1>
      <p className="text-muted-foreground">
        Timeline of all review rounds, summary evolution, and diff-between-rounds will appear here.
      </p>
    </div>
  );
}
