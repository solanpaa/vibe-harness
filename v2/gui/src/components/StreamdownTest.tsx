import { useState, useEffect, useRef } from "react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const SAMPLE_MARKDOWN = `# Streamdown Test

This is a **Vite + React** test of streaming markdown rendering.

## Features

- **Bold text** and *italic text*
- Inline \`code\` works
- Links: [Streamdown](https://streamdown.ai)

## Code Block

\`\`\`typescript
interface Task {
  id: string;
  status: "pending" | "running" | "completed";
  prompt: string;
}

function runTask(task: Task): Promise<void> {
  console.log(\`Running task \${task.id}\`);
  return Promise.resolve();
}
\`\`\`

## Another Language

\`\`\`python
def fibonacci(n: int) -> list[int]:
    """Generate Fibonacci sequence."""
    seq = [0, 1]
    for _ in range(n - 2):
        seq.append(seq[-1] + seq[-2])
    return seq

print(fibonacci(10))
\`\`\`

> Blockquotes also work.

---

| Feature | Status |
|---------|--------|
| Bold | ✅ |
| Code blocks | ✅ |
| Tables | ✅ |
| Streaming | ✅ |

1. Ordered lists
2. Also work
3. Just fine
`;

const INCOMPLETE_MARKDOWN = `# Incomplete Syntax Test

This has **unclosed bold

This has \`unclosed inline code

And an unclosed code block:

\`\`\`javascript
const x = 42;
// no closing fence

Still renders gracefully.
`;

export function StreamdownTest() {
  const [streamedText, setStreamedText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTab, setActiveTab] = useState<
    "static" | "streaming" | "incomplete"
  >("static");
  const intervalRef = useRef<number | null>(null);
  const indexRef = useRef(0);

  const startStreaming = () => {
    setStreamedText("");
    setIsStreaming(true);
    indexRef.current = 0;

    intervalRef.current = window.setInterval(() => {
      if (indexRef.current >= SAMPLE_MARKDOWN.length) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setIsStreaming(false);
        return;
      }
      // Append 3 characters at a time for visible streaming effect
      const end = Math.min(
        indexRef.current + 3,
        SAMPLE_MARKDOWN.length,
      );
      const next = SAMPLE_MARKDOWN.slice(0, end);
      indexRef.current = end;
      setStreamedText(next);
    }, 16);
  };

  const stopStreaming = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsStreaming(false);
  };

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const tabStyle = (tab: string) => ({
    padding: "0.5rem 1rem",
    cursor: "pointer",
    borderBottom: activeTab === tab ? "2px solid #3b82f6" : "2px solid transparent",
    background: "none",
    color: activeTab === tab ? "#3b82f6" : "#888",
    fontWeight: activeTab === tab ? 600 : 400,
    border: "none",
    borderBottomWidth: "2px",
    borderBottomStyle: "solid" as const,
    borderBottomColor: activeTab === tab ? "#3b82f6" : "transparent",
    fontSize: "0.9rem",
  });

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "2rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>
        Streamdown Vite Test
      </h1>
      <p style={{ color: "#888", marginBottom: "1.5rem", fontSize: "0.85rem" }}>
        streamdown@2.5.0 + @streamdown/code@1.1.1 — Vite + React 19, no Next.js
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button style={tabStyle("static")} onClick={() => setActiveTab("static")}>
          Static Render
        </button>
        <button style={tabStyle("streaming")} onClick={() => setActiveTab("streaming")}>
          Streaming Simulation
        </button>
        <button style={tabStyle("incomplete")} onClick={() => setActiveTab("incomplete")}>
          Incomplete Syntax
        </button>
      </div>

      <div
        style={{
          background: "#fff",
          border: "1px solid #e5e7eb",
          borderRadius: 8,
          padding: "1.5rem",
          minHeight: 300,
        }}
      >
        {activeTab === "static" && (
          <Streamdown plugins={{ code }}>{SAMPLE_MARKDOWN}</Streamdown>
        )}

        {activeTab === "streaming" && (
          <div>
            <div style={{ marginBottom: "1rem", display: "flex", gap: "0.5rem" }}>
              <button
                onClick={startStreaming}
                disabled={isStreaming}
                style={{
                  padding: "0.4rem 1rem",
                  borderRadius: 4,
                  border: "1px solid #3b82f6",
                  background: isStreaming ? "#94a3b8" : "#3b82f6",
                  color: "#fff",
                  cursor: isStreaming ? "not-allowed" : "pointer",
                  fontSize: "0.85rem",
                }}
              >
                {isStreaming ? "Streaming..." : "Start Stream"}
              </button>
              {isStreaming && (
                <button
                  onClick={stopStreaming}
                  style={{
                    padding: "0.4rem 1rem",
                    borderRadius: 4,
                    border: "1px solid #ef4444",
                    background: "#ef4444",
                    color: "#fff",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Stop
                </button>
              )}
            </div>
            <Streamdown plugins={{ code }} isAnimating={isStreaming}>
              {streamedText}
            </Streamdown>
            {!isStreaming && !streamedText && (
              <p style={{ color: "#aaa" }}>Click "Start Stream" to simulate AI output</p>
            )}
          </div>
        )}

        {activeTab === "incomplete" && (
          <div>
            <p style={{ color: "#888", fontSize: "0.85rem", marginBottom: "1rem" }}>
              Testing graceful handling of unclosed bold, inline code, and code blocks:
            </p>
            <Streamdown plugins={{ code }} isAnimating={true}>
              {INCOMPLETE_MARKDOWN}
            </Streamdown>
          </div>
        )}
      </div>
    </div>
  );
}
