export default function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Workflow Run</h1>
      <p className="text-muted-foreground">
        Workflow run detail with stage progression and review gates will appear here.
      </p>
    </div>
  );
}
