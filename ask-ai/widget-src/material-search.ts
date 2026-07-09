/**
 * The ONE Material-for-MkDocs coupling: a single "Ask AI" row pinned above
 * the keyword search results that hands the query to the drawer.
 *
 * Every selector is guarded and the whole install is best-effort: if a
 * Material update renames these hooks, the row simply never appears and
 * keyword search plus the floating button continue unaffected. Nothing else
 * in the widget touches the theme's DOM.
 */

const SEARCH_INPUT_SELECTOR = "input.md-search__input";
const SEARCH_OUTPUT_SELECTOR = ".md-search__output";
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
    const output = document.querySelector<HTMLElement>(SEARCH_OUTPUT_SELECTOR);
    if (!input || !output) return;
    if (input.hasAttribute(HOOKED_ATTRIBUTE)) return;
    input.setAttribute(HOOKED_ATTRIBUTE, "");

    const row = buildRow();
    const sync = (): void => {
      const query = input.value.trim();
      row.style.display = query === "" ? "none" : "block";
      row.textContent = `\u2726 ${title}: "${query}"`;
      if (!row.isConnected) output.prepend(row);
    };

    input.addEventListener("input", sync);
    // Material rebuilds the result list on every keystroke; re-pin our row.
    new MutationObserver(sync).observe(output, { childList: true });

    row.addEventListener("click", () => {
      const query = input.value.trim();
      closeMaterialSearch(input);
      if (query) target.askFromSearch(query);
    });
  } catch (error) {
    console.warn("[ask-widget] search integration skipped:", error);
  }
}

function buildRow(): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  // Inline styles on purpose: this element lives in Material's light DOM,
  // uses Material's own CSS variables to match the active palette, and must
  // not depend on any stylesheet of ours being loaded there.
  row.style.cssText = [
    "display: none",
    "width: 100%",
    "text-align: left",
    "cursor: pointer",
    "padding: .6em .8em",
    "border: 0",
    "border-bottom: 1px solid var(--md-default-fg-color--lightest, #eee)",
    "background: var(--md-default-bg-color, #fff)",
    "color: var(--md-accent-fg-color, #2f6fed)",
    "font-size: .7rem",
    "font-weight: 600",
  ].join(";");
  return row;
}

function closeMaterialSearch(input: HTMLInputElement): void {
  const toggle = document.querySelector<HTMLInputElement>(SEARCH_TOGGLE_SELECTOR);
  if (toggle) toggle.checked = false;
  input.blur();
}
