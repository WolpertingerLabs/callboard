import { memo, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';
import CopyButton from './CopyButton';
import rehypeResponsiveTables from './markdownTables';
import './MarkdownRenderer.css';

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

/**
 * A markdown table in its horizontal scroll wrapper.
 *
 * While — and only while — the table overflows, the wrapper becomes a
 * focusable, named region, so keyboard users can scroll it in browsers that do
 * not make scroll containers focusable (Safari). A table that fits stays out of
 * the tab order and out of the landmark list; a transcript can hold dozens.
 * A focused wrapper keeps its attributes until blur, so widening the pane
 * under it does not drop focus to <body>.
 */
function ScrollableTable({ tableProps, children }: { tableProps: ComponentProps<'table'>; children: ReactNode }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [focused, setFocused] = useState(false);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => setOverflows(wrap.scrollWidth > wrap.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    // Observing the table as well catches growth while a reply streams in.
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    if (wrap.firstElementChild) observer.observe(wrap.firstElementChild);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={wrapRef}
      className="md-table-wrap"
      data-stack={'data-stack' in tableProps ? '' : undefined}
      onFocus={(e) => e.target === e.currentTarget && setFocused(true)}
      onBlur={(e) => e.target === e.currentTarget && setFocused(false)}
      {...((overflows || focused) && { role: 'region', 'aria-label': 'Scrollable table', tabIndex: 0 })}
    >
      <table className="md-table" {...tableProps}>
        {children}
      </table>
    </div>
  );
}

// Hoisted to module scope so their identities are stable across renders.
// Inline arrays/objects here made react-markdown hand React a fresh component
// type for every `code`/`pre`/… on each render, which remounted every code
// block (re-running highlighting and resetting CopyButton's "copied" state)
// on each stream event and poll.
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight, rehypeResponsiveTables];

const components: Components = {
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

  // Tables scroll sideways inside their own wrapper rather than squeezing
  // columns; prose-heavy ones re-flow into cards at narrow widths. Layout
  // lives in MarkdownRenderer.css, driven by attributes markdownTables.ts adds.
  table: ({ children, node: _node, ...props }) => <ScrollableTable tableProps={props}>{children}</ScrollableTable>,

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
};

function MarkdownRenderer({ content, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default memo(MarkdownRenderer);
