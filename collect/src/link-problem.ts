// The page for a collect link that doesn't open a map: no token in it (cut short
// when copied), or one the server refuses (401: the map was deleted or the owner
// replaced the link; the server answers the same for both, so as not to reveal
// which maps exist). Plain reasons and the next step, in collect's own header.
import { ApiError } from './api';
import { collectTopbarHtml } from './topbar';

/** A refusal that means the link itself is wrong, not the connection. */
export function isLinkProblem(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

export function linkProblemHtml(): string {
  return `${collectTopbarHtml()}
    <div class="pad">
      <h1>This link doesn't open a map</h1>
      <p class="hint">Usually one of these:</p>
      <ul class="hint link-reasons">
        <li>The link was <strong>copied incompletely</strong>: the part after the # is missing.</li>
        <li>The map was <strong>deleted</strong>.</li>
        <li>The owner <strong>replaced the link</strong> with a new one.</li>
      </ul>
      <p class="hint"><strong>Ask whoever shared it for a fresh link.</strong></p>
      <a class="btn primary" href="/">Make a map</a>
    </div>`;
}
