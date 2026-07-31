// The fixed icon set.
//
// `Item.icon` is a token, never raw SVG — a `command` provider is user code
// producing JSON, and letting it hand markup to two windows would be an
// injection hole for the sake of a nicer glyph. Unknown tokens fall back to
// `dot`, so a typo in a config file degrades instead of breaking a row.
//
// Every glyph is a 24x24 stroked path set, matching the launcher's orb rail.
(function () {
  'use strict';

  const ICONS = {
    dot: '<circle cx="12" cy="12" r="4"/>',
    app: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 9h6v6H9z"/>',
    web: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/>',
    git: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M6 9v6"/><circle cx="18" cy="8" r="3"/><path d="M18 11v1a4 4 0 0 1-4 4H9"/>',
    check: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    health: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    command: '<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 0 0 0-6z"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    chevron: '<path d="M9 18l6-6-6-6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    // Light and dark, for the theme toggle: a sun for "switch to light", a
    // moon for "switch to dark". A grid glyph said nothing about either.
    sun: '<circle cx="12" cy="12" r="4.2"/><line x1="12" y1="1.5" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22.5"/><line x1="1.5" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22.5" y2="12"/><line x1="4.6" y1="4.6" x2="6.4" y2="6.4"/><line x1="17.6" y1="17.6" x2="19.4" y2="19.4"/><line x1="4.6" y1="19.4" x2="6.4" y2="17.6"/><line x1="17.6" y1="6.4" x2="19.4" y2="4.6"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    more: '<circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/><circle cx="5" cy="12" r="1.6"/>',
  };

  /** The action `kind` → icon token map, for the per-row action buttons. */
  const ACTION_ICONS = {
    openUrl: 'external',
    openPath: 'folder',
    run: 'play',
    copyText: 'copy',
    reveal: 'file',
  };

  function iconSvg(token, extraClass) {
    const body = ICONS[token] || ICONS.dot;
    const cls = extraClass ? ` class="${extraClass}"` : '';
    return `<svg viewBox="0 0 24 24"${cls}>${body}</svg>`;
  }

  /** Data URIs an item's custom icon may use, mirroring the backend's list. */
  const ICON_DATA_PREFIXES = [
    'data:image/png;base64,',
    'data:image/jpeg;base64,',
    'data:image/gif;base64,',
    'data:image/webp;base64,',
    'data:image/x-icon;base64,',
    'data:image/bmp;base64,',
  ];

  /**
   * An item's glyph: the user's own image when there is one, else a token.
   *
   * The data URI is re-checked here as well as in Rust. It goes into an
   * `<img src>`, and something that reaches a src attribute should be verified
   * by whoever is about to use it rather than on trust.
   */
  function itemIcon(item, extraClass) {
    const data = item && item.iconData;
    if (data && ICON_DATA_PREFIXES.some(prefix => data.startsWith(prefix))) {
      const cls = extraClass ? ` ${extraClass}` : '';
      return `<img class="custom-icon${cls}" src="${data}" alt="">`;
    }
    return iconSvg((item && item.icon) || 'dot', extraClass);
  }

  window.DevHubIcons = { ICONS, ACTION_ICONS, iconSvg, itemIcon, ICON_DATA_PREFIXES };
})();
