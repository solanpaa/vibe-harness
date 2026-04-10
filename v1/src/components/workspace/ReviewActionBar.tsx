import { Button } from "@/components/ui/button";
import { Check, MessageSquare } from "lucide-react";

interface ReviewActionBarProps {
  isPending: boolean;
  totalComments: number;
  submitting: boolean;
  onSubmit: (action: "approve" | "request_changes") => void;
}

export function ReviewActionBar({
  isPending,
  totalComments,
  submitting,
  onSubmit,
}: ReviewActionBarProps) {
  if (!isPending) return null;

  return (
    <div className="flex items-center gap-3 px-4 pb-3">
      <Button
        onClick={() => onSubmit("approve")}
        className="bg-green-600 hover:bg-green-700 shadow-sm"
        disabled={submitting}
      >
        <Check className="mr-2 h-4 w-4" />
        Approve
      </Button>
      <Button
        variant="outline"
        onClick={() => onSubmit("request_changes")}
        disabled={totalComments === 0 || submitting}
      >
        <MessageSquare className="mr-2 h-4 w-4" />
        Request Changes ({totalComments})
      </Button>
      {totalComments === 0 && (
        <span className="text-xs text-muted-foreground">
          Add comments before requesting changes
        </span>
      )}
    </div>
  );
}
