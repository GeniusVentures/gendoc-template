/**
 * The ONE Material-for-MkDocs coupling: a 💬 button inside the search
 * bar's .md-search__options that opens the Ask drawer with the current
 * search query.
 *
 * Fuzzy typo-correction is handled separately by search-fuzzy.js (loaded
 * via injectors.js before Material initialises).
 *
 * Every selector is guarded and the whole install is best-effort: if a
 * Material update renames these hooks, the button simply never appears
 * and the floating button continues unaffected. Nothing else in the
 * widget touches the theme's DOM.
 */

const SEARCH_INPUT_SELECTOR = "input.md-search__input";
const SEARCH_OPTIONS_SELECTOR = ".md-search__options";
const SEARCH_TOGGLE_SELECTOR = "#__search";
/** Marks an input we already hooked, so reinstalls are idempotent. */
const HOOKED_ATTRIBUTE = "data-ask-hooked";

export interface SearchHookTarget {
  /** Open the drawer and ask the given question. */
  askFromSearch(question: string): void;
}

/**
 * Safe to call repeatedly (it is re-run after every Material instant-
 * navigation page swap, which rebuilds the search DOM): already-hooked
 * inputs are skipped, and listeners on destroyed elements are collected
 * with them.
 */
export function installMaterialSearchHook(title: string, target: SearchHookTarget): void {
  try {
    const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR);
    const options = document.querySelector<HTMLElement>(SEARCH_OPTIONS_SELECTOR);
    if (!input || !options) return;
    if (input.hasAttribute(HOOKED_ATTRIBUTE)) return;
    input.setAttribute(HOOKED_ATTRIBUTE, "");

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-search__ask";
    const icon = getComputedStyle(document.documentElement).getPropertyValue('--ask-icon').trim() || '💬';
    btn.textContent = `${icon} ${title}`;
    btn.title = `${title}: ask a question about the docs`;
    // Inline styles to keep this self-contained — no stylesheet dependency.
    btn.style.cssText =
      "margin:0;padding:0 .5rem;cursor:pointer;background:none;border:0;" +
      "font-size:.7rem;font-weight:600;line-height:1;white-space:nowrap;" +
      "color:var(--md-accent-fg-color,#2f6fed);position:relative;z-index:9999;pointer-events:auto";

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const query = input.value.trim();
      closeMaterialSearch(input);
      // Defer so Material's focus-restore handlers don't steal focus
      // back from the drawer input.
      setTimeout(() => target.askFromSearch(query), 0);
    });

    options.appendChild(btn);
  } catch (error) {
    console.warn("[ask-widget] search integration skipped:", error);
  }
}

function closeMaterialSearch(input: HTMLInputElement): void {
  const toggle = document.querySelector<HTMLInputElement>(SEARCH_TOGGLE_SELECTOR);
  if (toggle) toggle.checked = false;
  input.blur();
}
