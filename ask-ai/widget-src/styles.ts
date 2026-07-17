/**
 * Drawer styles, adopted into the widget's shadow root.  All colors use
 * CSS custom properties (--ask-*) so projects can theme the drawer by
 * overriding variables in their own stylesheet (e.g. extra_css in mkdocs.yml).
 * Shadow DOM inherits custom properties from the light DOM automatically.
 */
export const DRAWER_CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: var(--ask-font, system-ui, -apple-system, "Segoe UI", sans-serif); }

  .fab {
    position: fixed; right: 20px; bottom: 20px; z-index: 9998;
    border: 0; border-radius: 24px; padding: 12px 20px;
    font-size: 14px; font-weight: 600; cursor: pointer; color: var(--ask-on-accent, #fff);
    background: var(--ask-accent, #2f6fed);
    box-shadow: 0 4px 14px rgba(0, 0, 0, .25);
    white-space: nowrap;
  }

  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; z-index: 9999;
    width: var(--ask-drawer-width, min(420px, 100vw)); height: 100dvh;
    min-width: 300px; max-width: 90vw;
    display: flex; flex-direction: column;
    background: var(--ask-drawer-bg, #fff);
    color: var(--ask-drawer-fg, #16232e);
    border-left: 1px solid var(--ask-drawer-border, #d6dde3);
    box-shadow: -8px 0 32px rgba(0, 0, 0, .25);
    transform: translateX(105%);
    transition: transform .25s ease;
    overflow: auto;
  }
  .drawer::before {
    content: ""; position: absolute; left: 0; top: 0; bottom: 0;
    width: 6px; cursor: ew-resize; z-index: 1;
  }
  .drawer.open { transform: translateX(0); }

  .head {
    flex: none; padding: 14px 16px;
    background: var(--ask-accent, #2f6fed); color: var(--ask-on-accent, #fff);
    display: flex; justify-content: space-between; align-items: center;
  }
  .head b { font-size: 14px; }
  .head-buttons { display: flex; gap: 4px; align-items: center; }
  .head button {
    background: none; border: 0; color: var(--ask-on-accent, #fff); cursor: pointer;
    font-size: 16px; line-height: 1; padding: 4px 6px; opacity: .9;
  }
  .head button:hover { opacity: 1; }
  .close { font-size: 20px !important; font-weight: 700; }
  .new-chat, .history-btn { font-size: 12px !important; opacity: .75 !important; }

  .session-list {
    max-height: 40vh; overflow-y: auto;
    border-bottom: 1px solid var(--ask-session-border, #e2e8ee);
    background: var(--ask-session-bg, #f8f9fb);
  }
  .session-item {
    display: flex; align-items: center; gap: 6px;
    width: 100%; padding: 8px 12px; border: 0;
    border-bottom: 1px solid var(--ask-session-item-border, #eef1f5);
    background: none; cursor: pointer; text-align: left; font-size: 12.5px;
    color: inherit;
  }
  .session-item.active { background: var(--ask-session-active, #e8ecf1); font-weight: 600; }
  .session-item:hover { background: var(--ask-session-hover, #eef1f5); }
  .session-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session-date { color: var(--ask-muted-fg, #8899aa); font-size: 11px; flex: none; }
  .session-del { color: var(--ask-danger, #cc6666); font-size: 14px; flex: none; padding: 0 4px; opacity: 0; }
  .session-item:hover .session-del { opacity: 1; }

  .messages {
    flex: 1; overflow-y: auto; padding: 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  .scroll-bottom {
    position: absolute; bottom: 60px; right: 20px; z-index: 10;
    width: 36px; height: 36px; border: 1px solid var(--ask-drawer-border, #d6dde3);
    border-radius: 50%; background: var(--ask-drawer-bg, #fff);
    color: var(--ask-accent, #2f6fed); font-size: 16px; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,.15);
  }
  .message {
    min-width: 0; max-width: 88%; padding: 9px 12px; border-radius: 10px;
    font-size: 13.5px; line-height: 1.5;
    word-wrap: break-word;
  }
  .message.user {
    align-self: flex-end; color: var(--ask-on-accent, #fff);
    white-space: pre-wrap;
    background: var(--ask-accent, #2f6fed);
    border-bottom-right-radius: 3px;
  }
  .message.assistant {
    align-self: flex-start;
    white-space: normal;
    background: var(--ask-msg-bg, #f1f4f7);
    border: 1px solid var(--ask-msg-border, #e2e8ee);
    border-bottom-left-radius: 3px;
  }
  .message.assistant code {
    background: var(--ask-code-bg, #e6ebf1); padding: 1px 4px; border-radius: 3px;
    font-family: ui-monospace, Menlo, monospace; font-size: 12px;
  }
  .message.assistant a { color: var(--ask-accent, #2f6fed); }
  .message.assistant h1, .message.assistant h2, .message.assistant h3, .message.assistant h4 { margin: 8px 0 4px; font-weight: 600; line-height: 1.3; }
  .message.assistant h1 { font-size: 16px; }
  .message.assistant h2 { font-size: 15px; }
  .message.assistant h3 { font-size: 14px; }
  .message.assistant h4 { font-size: 13px; }
  .message.assistant .body {
    min-width: 0;
    max-width: 100%;
  }
  .message.assistant .body > :first-child { margin-top: 0; }
  .message.assistant .body > :last-child { margin-bottom: 0; }
  .message.assistant ul, .message.assistant ol {
    margin: var(--ask-list-margin, 4px 0);
  }
  .message.assistant ul { padding-left: var(--ask-list-padding, 20px); }
  .message.assistant ol { padding-left: var(--ask-ordered-list-padding, 26px); }
  .message.assistant li { margin: var(--ask-list-item-margin, 2px 0); }
  .message.assistant p { margin: var(--ask-paragraph-margin, 4px 0); }
  .message.assistant li > p { margin: var(--ask-list-paragraph-margin, 0); }
  .message.assistant table {
    display: block; max-width: 100%; width: 100%; overflow-x: auto;
    border-collapse: collapse; margin: 6px 0; font-size: 12px;
  }
  .message.assistant th, .message.assistant td { border: 1px solid var(--ask-drawer-border, #d6dde3); padding: 4px 8px; text-align: left; }
  .message.assistant th { background: var(--ask-code-bg, #e6ebf1); font-weight: 600; }
  .message.assistant tr:nth-child(even) td { background: var(--ask-msg-bg, #f1f4f7); }
  .message.assistant pre {
    max-width: 100%; margin: 6px 0; padding: 8px 10px;
    background: var(--ask-code-bg, #e6ebf1); border-radius: 4px;
    overflow-x: auto; font-size: 12px;
  }
  .message.assistant pre code { background: none; padding: 0; }
  .message.assistant blockquote { margin: 6px 0; padding: 4px 10px; border-left: 3px solid var(--ask-accent, #2f6fed); color: var(--ask-muted-fg, #6b7b8b); }
  .message.assistant hr { border: 0; border-top: 1px solid var(--ask-drawer-border, #d6dde3); margin: 8px 0; }

  .thinking {
    margin: 0 0 8px 0; font-size: 11px; color: var(--ask-muted-fg, #6b7b8b);
  }
  .thinking summary {
    cursor: pointer; user-select: none; padding: 2px 0;
  }
  .thinking.streaming summary::after {
    content: "";
    animation: thinking-dots 1.4s steps(4, end) infinite;
  }
  @keyframes thinking-dots {
    0%   { content: ""; }
    25%  { content: "."; }
    50%  { content: ".."; }
    75%  { content: "..."; }
    100% { content: "..."; }
  }
  .thinking pre {
    white-space: pre-wrap; word-wrap: break-word; overflow-wrap: break-word;
    max-width: 100%; overflow-x: auto;
    margin: 4px 0 0 0; padding: 6px 8px;
    background: var(--ask-thinking-bg, #f4f6f8); border-radius: 4px;
    font-family: ui-monospace, Menlo, monospace; font-size: 11px;
    line-height: 1.4;
  }

  .sources { margin-top: 8px; font-size: 11px; border-top: 1px solid var(--ask-drawer-border, #e2e8ee); padding-top: 6px; }
  .sources summary {
    cursor: pointer; user-select: none; color: var(--ask-muted-fg, #5c6b78); padding: 2px 0;
  }
  .sources a {
    color: var(--ask-accent, #2f6fed);
    display: block; text-decoration: none; word-break: break-all; margin-top: 4px;
    padding-left: 8px; border-left: 2px solid var(--ask-drawer-border, #e2e8ee);
  }

  .provider {
    display: inline-block; font-size: 10px; color: var(--ask-muted-fg, #8899aa);
    text-transform: uppercase; letter-spacing: .5px;
    margin: 0 0 4px 0;
  }
  .hint { color: var(--ask-muted-fg, #5c6b78); font-size: 12.5px; margin: auto; text-align: center; padding: 0 20px; }

  form { flex: none; display: flex; gap: 8px; padding: 12px; border-top: 1px solid var(--ask-drawer-border, #e2e8ee); }
  input {
    flex: 1; border: 1px solid var(--ask-input-border, #d6dde3); border-radius: 8px;
    padding: 9px 11px; font-size: 13.5px;
    background: var(--ask-input-bg, #fff); color: inherit;
    outline-color: var(--ask-accent, #2f6fed);
  }
  form button[type=submit] {
    border: 0; border-radius: 8px; padding: 9px 14px;
    font-weight: 600; font-size: 13px; cursor: pointer;
    background: var(--ask-accent, #2f6fed); color: var(--ask-on-accent, #fff);
  }
  form button[type=submit]:disabled { opacity: .5; }

  /* Dark theme — synced via data-theme attribute from Material MkDocs toggle */
  .drawer[data-theme="dark"] {
    --ask-drawer-bg: var(--ask-dark-bg, #1a2129);
    --ask-drawer-fg: var(--ask-dark-fg, #dbe4ec);
    --ask-drawer-border: var(--ask-dark-border, #2c3944);
    --ask-msg-bg: var(--ask-dark-msg-bg, #232d38);
    --ask-msg-border: var(--ask-dark-border, #2c3944);
    --ask-code-bg: var(--ask-dark-border, #2c3944);
    --ask-input-bg: var(--ask-dark-msg-bg, #232d38);
    --ask-input-border: var(--ask-dark-border, #2c3944);
    --ask-thinking-bg: var(--ask-dark-bg, #1a2129);
    --ask-session-bg: var(--ask-dark-session-bg, #19212b);
    --ask-session-border: var(--ask-dark-border, #2c3944);
    --ask-session-item-border: var(--ask-dark-session-item-border, #1e2732);
    --ask-session-active: var(--ask-dark-session-item-border, #1e2732);
    --ask-session-hover: var(--ask-dark-session-item-border, #1e2732);
    --ask-muted-fg: var(--ask-dark-muted-fg, #8fa1b0);
  }
  .drawer[data-theme="dark"] .thinking pre { color: var(--ask-dark-thinking-fg, #a0b0c0); }
  .drawer[data-theme="dark"] .sources a { color: var(--ask-dark-link, #6fa8f0); }
`;
