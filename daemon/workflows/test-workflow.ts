import { createHook } from "workflow";

/**
 * Step 1: Process input (simulates work like planning or code generation).
 */
async function processStep(input: string): Promise<string> {
  "use step";
  console.log(`[process] Working on: ${input}`);
  await new Promise((r) => setTimeout(r, 100));
  return `Processed: "${input}" → result ready for review`;
}

/**
 * Step 2: Finalize after hook resolution.
 */
async function finalizeStep(
  processed: string,
  hookResult: Record<string, unknown>,
): Promise<string> {
  "use step";
  console.log(`[finalize] Completing with hook payload:`, hookResult);
  await new Promise((r) => setTimeout(r, 100));
  return `Finalized: ${processed} | hook payload: ${JSON.stringify(hookResult)}`;
}

/**
 * Two-step workflow with a human-in-the-loop hook between them.
 *
 * 1. processStep  — runs immediately
 * 2. createHook   — workflow suspends, waits for external resume
 * 3. finalizeStep — runs after hook is resolved
 */
export async function testWorkflow(input: {
  input: string;
  hookToken: string;
}) {
  "use workflow";

  const processed = await processStep(input.input);

  using hook = createHook<Record<string, unknown>>({
    token: input.hookToken,
  });

  const hookResult = await hook;

  const finalized = await finalizeStep(processed, hookResult);

  return { processed, finalized, status: "completed" };
}
