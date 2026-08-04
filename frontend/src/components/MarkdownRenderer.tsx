import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';
import CopyButton from './CopyButton';

interface Props {
  content: string;
  className?: string;
}

/**
 * Concatenates every text descendant of a hast node.
 *
 * The code a block's copy button yields is recovered from the syntax tree
 * rather than the rendered DOM: by the time React sees it, rehype-highlight has
 * shredded the source into nested `<span>`s, and reading `textContent` off the
 * wrapper would also sweep up anything else rendered alongside it.
 */
function nodeText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { value?: unknown; children?: unknown };
  if (typeof n.value === 'string') return n.value;
  if (Array.isArray(n.children)) return n.children.map(nodeText).join('');
  return '';
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
              color: 'var(--accent-text)',
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

        // Custom styling for pre blocks (code blocks), plus a copy button for
        // the block's source. The button is a sibling of the <pre> rather than
        // a child so it never scrolls away with long lines, never lands inside
        // a text selection of the code, and stays a direct child of
        // `.code-block` — which is what the hover-reveal rule in index.css
        // matches. The vertical margin moves to the wrapper so the button can
        // be positioned against the block's real top edge.
        pre: ({ children, node, ...props }) => {
          const code = nodeText(node).replace(/\n$/, '');
          return (
            <div className="code-block" style={{ position: 'relative', margin: '8px 0' }}>
              <pre
                style={{
                  background: 'var(--code-bg)',
                  padding: '12px',
                  borderRadius: '6px',
                  overflow: 'auto',
                  margin: 0,
                  fontSize: '13px',
                  fontFamily: 'monaco, "Courier New", monospace',
                }}
                {...props}
              >
                {children}
              </pre>
              {code && (
                <CopyButton
                  text={code}
                  title="Copy code"
                  className="code-copy-btn"
                  size={13}
                  style={{ position: 'absolute', top: 6, right: 6 }}
                />
              )}
            </div>
          );
        },
      }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}