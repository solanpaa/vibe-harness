export default function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-tight">Project Detail</h1>
      <p className="text-muted-foreground">Project details and subprojects will appear here.</p>
    </div>
  );
}
