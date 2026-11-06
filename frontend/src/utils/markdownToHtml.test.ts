import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./markdownToHtml";

describe("markdownToHtml", () => {
  it("renders inline formatting, links and lists as bare tags", () => {
    expect(markdownToHtml("Hi **b** _i_ `c` [l](https://x.dev/?a=1&b=2)")).toBe(
      '<p>Hi <strong>b</strong> <em>i</em> <code>c</code> <a href="https://x.dev/?a=1&amp;b=2">l</a></p>',
    );
    expect(markdownToHtml("3. a\n4. b")).toBe('<ol start="3">\n<li>a</li>\n<li>b</li>\n</ol>');
  });

  it("keeps a fenced block's language class and escapes its source", () => {
    expect(markdownToHtml("```ts\nif (a < b) {}\n```")).toBe('<pre><code class="language-ts">if (a &lt; b) {}\n</code></pre>');
  });

  it("renders GFM tables, strikethrough and task lists", () => {
    const html = markdownToHtml("| a | b |\n|:--|--:|\n| 1 | 2 |\n\n~~x~~\n\n- [x] done");
    expect(html).toContain('<th align="left">a</th>');
    expect(html).toContain('<td align="right">2</td>');
    expect(html).toContain("<del>x</del>");
    expect(html).toContain('<input type="checkbox" checked disabled>');
  });

  it("drops raw HTML from the markdown rather than passing it through", () => {
    const html = markdownToHtml('a <img src=x onerror="alert(1)"> b\n\n<script>alert(1)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });
});
