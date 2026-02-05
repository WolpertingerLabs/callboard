import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';

interface Props {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
        // Custom styling for code blocks
        code: ({ children, className, ...props }) => {
          const isInline = !className;
          return isInline ? (
            <code
              style={{
                background: 'var(--code-bg)',
                padding: '2px 4px',
                borderRadius: '3px',
                fontSize: '0.9em',
                fontFamily: 'monaco, "Courier New", monospace',
              }}
              {...props}
            >
              {children}
            </code>
          ) : (
            <code className={className} {...props}>
              {children}
            </code>
          );
        },

        // Custom styling for block quotes
        blockquote: ({ children, ...props }) => (
          <blockquote
            style={{
              borderLeft: '4px solid var(--accent)',
              paddingLeft: '12px',
              margin: '8px 0',
              color: 'var(--text-muted)',
              fontStyle: 'italic',
            }}
            {...props}
          >
            {children}
          </blockquote>
        ),

        // Custom styling for tables
        table: ({ children, ...props }) => (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              margin: '8px 0',
            }}
            {...props}
          >
            {children}
          </table>
        ),

        th: ({ children, ...props }) => (
          <th
            style={{
              border: '1px solid var(--border)',
              padding: '6px 8px',
              background: 'var(--assistant-bg)',
              textAlign: 'left',
              fontWeight: 600,
            }}
            {...props}
          >
            {children}
          </th>
        ),

        td: ({ children, ...props }) => (
          <td
            style={{
              border: '1px solid var(--border)',
              padding: '6px 8px',
            }}
            {...props}
          >
            {children}
          </td>
        ),

        // Custom styling for links
        a: ({ children, href, ...props }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
            {...props}
          >
            {children}
          </a>
        ),

        // Custom styling for horizontal rules
        hr: ({ ...props }) => (
          <hr
            style={{
              border: 'none',
              borderTop: '1px solid var(--border)',
              margin: '16px 0',
            }}
            {...props}
          />
        ),

        // Custom styling for pre blocks (code blocks)
        pre: ({ children, ...props }) => (
          <pre
            style={{
              background: 'var(--code-bg)',
              padding: '12px',
              borderRadius: '6px',
              overflow: 'auto',
              margin: '8px 0',
              fontSize: '13px',
              fontFamily: 'monaco, "Courier New", monospace',
            }}
            {...props}
          >
            {children}
          </pre>
        ),
      }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}