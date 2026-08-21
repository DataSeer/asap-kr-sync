/**
 * `v-tooltip` — the app's own hover/focus tooltip, replacing the browser's
 * native `title` attribute everywhere.
 *
 * Why a directive rather than a component: this replaces ~200 `title=`
 * attributes across 30 files. A wrapper component would mean restructuring
 * markup at every one of those sites; a directive is a near 1:1 swap
 * (`title="x"` → `v-tooltip="'x'"`) and leaves the DOM shape alone.
 *
 * Why ONE element on `document.body` rather than one per target:
 *
 *   - most of these tooltips live inside tables and panels with
 *     `overflow: auto`, which clips an in-flow absolutely-positioned tooltip.
 *     The KRT editor works around that with hand-written above/below variants;
 *     a body-level layer has no such problem anywhere;
 *   - a `z-index` fight with modals and sticky headers is decided once;
 *   - 200 idle listeners and 200 hidden nodes is a cost paid on every render,
 *     for something only ever visible one at a time.
 *
 * Usage:
 *   <button v-tooltip="'Delete this row'">
 *   <span v-tooltip="row.longValue">        // falsy → no tooltip at all
 *   <span v-tooltip.right="'Details'">      // placement: top (default)|right|bottom|left
 */

const OFFSET = 8;      // px between the target and the tooltip
const MARGIN = 6;      // px minimum from the viewport edge
const SHOW_DELAY = 120; // ms — long enough that sweeping the mouse across a
                        // table does not strobe tooltips at the user

let layer = null;
let showTimer = null;
let current = null;   // the element whose tooltip is showing (or pending)

/** The single tooltip node, created on first use. */
function getLayer() {
  if (layer) return layer;
  layer = document.createElement('div');
  layer.className = 'app-tooltip';
  layer.setAttribute('role', 'tooltip');
  layer.dataset.show = 'false';
  document.body.appendChild(layer);
  return layer;
}

/** Clamp to the viewport so a tooltip near an edge stays readable. */
function position(el, placement) {
  const node = getLayer();
  const t = el.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;

  let top;
  let left;
  switch (placement) {
    case 'bottom': top = t.bottom + OFFSET; left = t.left + (t.width - w) / 2; break;
    case 'left':   top = t.top + (t.height - h) / 2; left = t.left - w - OFFSET; break;
    case 'right':  top = t.top + (t.height - h) / 2; left = t.right + OFFSET; break;
    default:       top = t.top - h - OFFSET; left = t.left + (t.width - w) / 2;
  }

  // Flip a top-placed tooltip that would leave the viewport, rather than
  // pinning it over the element it describes.
  if (placement === 'top' && top < MARGIN) top = t.bottom + OFFSET;
  if (placement === 'bottom' && top + h > window.innerHeight - MARGIN) top = t.top - h - OFFSET;

  left = Math.min(Math.max(MARGIN, left), window.innerWidth - w - MARGIN);
  top = Math.min(Math.max(MARGIN, top), window.innerHeight - h - MARGIN);

  node.style.top = `${Math.round(top)}px`;
  node.style.left = `${Math.round(left)}px`;
}

function show(el) {
  const text = el.__tooltipText;
  if (!text) return;
  const node = getLayer();
  node.textContent = text;
  node.dataset.show = 'true';
  // Positioned AFTER the text is in, because placement depends on the size the
  // text gives it.
  position(el, el.__tooltipPlacement || 'top');
  current = el;
}

function hide() {
  clearTimeout(showTimer);
  showTimer = null;
  current = null;
  if (layer) layer.dataset.show = 'false';
}

function onEnter(event) {
  const el = event.currentTarget;
  if (!el.__tooltipText) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => show(el), SHOW_DELAY);
}

/** Focus shows immediately — a keyboard user has already committed to the element. */
function onFocus(event) {
  const el = event.currentTarget;
  if (!el.__tooltipText) return;
  clearTimeout(showTimer);
  show(el);
}

/**
 * Anything that moves or removes the target hides the tooltip: a click that
 * opens a modal, a scroll that carries the row away, Escape. Without this the
 * tooltip strands itself over unrelated content — the failure that makes a
 * hand-rolled tooltip worse than the native one it replaced.
 */
function onLeave() { hide(); }

function bind(el, binding) {
  el.__tooltipText = binding.value == null ? '' : String(binding.value).trim();
  el.__tooltipPlacement = ['top', 'bottom', 'left', 'right']
    .find((p) => binding.modifiers[p]) || 'top';

  // A native title on the same element would double up — one instantly, one
  // styled. The directive owns the tooltip, so the attribute goes.
  if (el.hasAttribute('title')) el.removeAttribute('title');

  if (el.__tooltipBound) {
    // Re-bind on update: refresh the text, keep the listeners, and if this
    // element's tooltip is on screen right now, update it in place.
    if (current === el) {
      if (el.__tooltipText) show(el);
      else hide();
    }
    return;
  }

  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('focus', onFocus);
  el.addEventListener('blur', onLeave);
  el.addEventListener('click', onLeave);
  el.__tooltipBound = true;
}

function unbind(el) {
  if (current === el) hide();
  el.removeEventListener('mouseenter', onEnter);
  el.removeEventListener('mouseleave', onLeave);
  el.removeEventListener('focus', onFocus);
  el.removeEventListener('blur', onLeave);
  el.removeEventListener('click', onLeave);
  delete el.__tooltipBound;
  delete el.__tooltipText;
  delete el.__tooltipPlacement;
}

// A tooltip anchored to something that has scrolled away is worse than none.
// Capture phase so it fires for scrolls inside the app's inner containers, not
// just the window — this page scrolls inside a container, not the window.
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => { if (current) hide(); }, true);
  window.addEventListener('resize', () => { if (current) hide(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current) hide(); });
}

export const tooltip = {
  mounted: bind,
  updated: bind,
  beforeUnmount: unbind
};

/** Exported for tests — the directive keeps module-level state. */
export const __testing = {
  reset() {
    hide();
    if (layer) { layer.remove(); layer = null; }
  },
  get layer() { return layer; },
  showNow(el) { show(el); }
};

export default tooltip;
