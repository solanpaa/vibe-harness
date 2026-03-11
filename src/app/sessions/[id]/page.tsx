export default function SessionDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Session</h1>
      <p className="text-muted-foreground">
        Live terminal view and session controls will appear here.
      </p>
    </div>
  );
}
