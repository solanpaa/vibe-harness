import { Card, CardContent } from "@/components/ui/card";

export default function ReviewsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Reviews</h1>
        <p className="text-muted-foreground">
          Review AI-generated changes with inline comments — like a local PR review
        </p>
      </div>

      <Card>
        <CardContent className="flex items-center justify-center h-48">
          <div className="text-center text-muted-foreground">
            <p>No reviews yet.</p>
            <p className="text-sm">Reviews are created automatically when agent sessions complete.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
