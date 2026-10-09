import { useMemo } from "react";
import { renderMarkdown } from "../utils/markdown";

interface MarkdownProps {
  content: string;
  className?: string;
}

export function Markdown({ content, className = "" }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className={`md-content ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
