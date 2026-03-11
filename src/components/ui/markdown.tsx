"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none
      prose-headings:font-semibold
      prose-h1:text-lg prose-h1:mt-6 prose-h1:mb-3 prose-h1:border-b prose-h1:border-border prose-h1:pb-2
      prose-h2:text-base prose-h2:mt-5 prose-h2:mb-2
      prose-h3:text-sm prose-h3:mt-4 prose-h3:mb-1
      prose-p:my-2 prose-p:leading-relaxed
      prose-li:my-0.5
      prose-ul:my-2 prose-ol:my-2
      prose-pre:rounded-lg prose-pre:border prose-pre:border-border prose-pre:bg-muted prose-pre:text-foreground prose-pre:text-xs
      prose-code:rounded prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:font-normal prose-code:before:content-none prose-code:after:content-none
      prose-strong:text-foreground
      prose-blockquote:border-l-primary prose-blockquote:text-muted-foreground
      prose-table:text-xs
      prose-th:px-3 prose-th:py-2 prose-th:text-left prose-th:font-medium prose-th:border-b prose-th:border-border
      prose-td:px-3 prose-td:py-2 prose-td:border-b prose-td:border-border
      prose-hr:border-border prose-hr:my-4
      prose-a:text-primary prose-a:no-underline hover:prose-a:underline
      prose-img:rounded-lg
    ">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
