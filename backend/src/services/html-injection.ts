/**
 * Scripts injected into sandboxed HTML documents before they are served —
 * shared by canvases (routes/canvas.ts) and artifacts (routes/artifacts.ts).
 */

/**
 * Small script injected before </body> in HTML canvases and artifacts.
 * Reports document dimensions to the parent via postMessage so the
 * iframe can auto-resize and scale to fit. Works even with
 * sandbox="allow-scripts" (no allow-same-origin needed).
 * Uses ResizeObserver to track dynamic changes.
 */
export const SIZE_REPORTER_SCRIPT = `<script>
(function(){
  function send(){
    var h = document.documentElement.scrollHeight;
    var w = document.documentElement.scrollWidth;
    window.parent.postMessage({type:"canvas-resize",height:h,width:w},"*");
  }
  if(typeof ResizeObserver!=="undefined"){
    new ResizeObserver(send).observe(document.documentElement);
  }
  window.addEventListener("load",send);
  send();
})();
</script>`;

/** Insert `snippet` before the first `</body>`, or append it when there is none. */
export function injectBeforeBodyClose(html: string, snippet: string): string {
  const at = html.indexOf("</body>");
  return at === -1 ? html + snippet : html.slice(0, at) + snippet + html.slice(at);
}
