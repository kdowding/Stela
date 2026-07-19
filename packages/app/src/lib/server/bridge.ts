// Server-side glue for the embed bridge (bridge.client.js). The bridge is imported as raw text and
// injected into an artifact's HTML at serve time on the portal-embed path only — the stored blob and
// the standalone /raw response stay pristine. See bridge.client.js for what runs in the iframe.
//
// Imported ?raw (not as a module) so the regex-heavy script can't be corrupted by TS/JS escape handling
// and never enters the type/lint graph as executable code.
import bridgeScript from "./bridge.client.js?raw";

// Bump whenever bridge.client.js changes. The /raw route folds this into the embed variant's ETag so a
// bridge update busts cached embed loads, while the artifact's own immutable cache stays untouched.
export const BRIDGE_VERSION = 4;

const TAG = `<script>${bridgeScript}</script>`;

// Index-splice rather than String.replace: the bridge text is data, and replace() would interpret any
// `$&`/`$1` in it as a replacement pattern.
function insertAt(html: string, needle: RegExp): string | null {
  const m = needle.exec(html);
  return m ? html.slice(0, m.index) + TAG + html.slice(m.index) : null;
}

/** Inject the embed bridge before </body> (then </html>, else append). Serve-time only. */
export function injectBridge(html: string): string {
  return insertAt(html, /<\/body>/i) ?? insertAt(html, /<\/html>/i) ?? html + TAG;
}
