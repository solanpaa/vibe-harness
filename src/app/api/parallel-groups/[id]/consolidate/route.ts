import { NextRequest, NextResponse } from "next/server";
import { consolidateParallelGroup } from "@/lib/services/parallel-launcher";

/**
 * POST /api/parallel-groups/[id]/consolidate — merge all child branches.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const result = consolidateParallelGroup(id);

    if (result.success) {
      return NextResponse.json({
        status: "consolidated",
        branch: result.branch,
        mergedCount: result.mergedCount,
      });
    } else {
      return NextResponse.json(
        {
          status: "failed",
          branch: result.branch,
          mergedCount: result.mergedCount,
          error: result.error,
        },
        { status: result.error?.includes("not found") ? 404 : 409 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
