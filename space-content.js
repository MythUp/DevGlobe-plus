'use strict';

(function () {
  // Constants
  const FLAG_CLASS = 'devglobe-flag';
  const FLAG_TOOLTIP_CLASS = 'devglobe-flag-tooltip';
  const THEME_CACHE_KEY = 'devglobe.cachedTheme.v1';
  const BLOCKED_LINK_CLASS = 'devglobe-repo-link--blocked';
  const FEATURE_SETTINGS_KEY = 'devglobe.featureSettings.v1';
  const STATS_SORTABLE_COLUMN_LABELS = new Set(['hours', 'devs', 'growth']);
  const STATS_SORT_BUTTON_CLASS = 'devglobe-stats-sort-button';
  const STATS_SORT_ARROW_CLASS = 'devglobe-stats-sort-arrow';
  const STATS_SORTABLE_HEADER_CLASS = 'devglobe-stats-sortable-header';
  const STATS_TABLE_STYLE_ID = 'devglobe-stats-table-style';
  const SCAN_INTERVAL_MS = 1500;
  const CACHE_FRESHNESS_MS = 2 * 60 * 1000;
  
  // Default settings
  const DEFAULT_FEATURE_SETTINGS = {
    flagTooltipsEnabled: true,
    repositoryBlockingEnabled: true,
    statsTableSortingEnabled: true,
    searchKeyboardShortcutEnabled: true,
    dropdownNavigationEnabled: true,
    escapeKeyClosesModals: true,
    replaceCommandKeyEnabled: false
  };
  let featureSettings = { ...DEFAULT_FEATURE_SETTINGS };

  // Appliquer le remplacement initial en fonction des paramètres par défaut
  applyCommandKeyReplacement();

  let tooltipElement = null;
  let tooltipVisible = false;
  let activeTooltipAnchor = null;
  let tooltipHideTimer = null;
  let countryDisplayNames = null;
  let languageDisplayNames = null;
  let repositoryStateCache = new Map();
  let pendingRepositoryRequests = new Map();
  const repositoryNavigationReplay = new WeakSet();
  const statsTableSortStateByKey = new Map();
  let mutationObserver = null;
  let scanIntervalId = null;
  let scanQueued = false;
  let cacheReadyPromise = null;
  let lastPersistedTheme = null;
  let detectScheduled = null;
  let detectRunning = false;

  // Listen for messages from the popup script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'updateCommandKeySetting') {
      featureSettings.replaceCommandKeyEnabled = request.enabled;
      applyCommandKeyReplacement(); // Appliquer le changement immédiatement
    }
  });

  try {
    countryDisplayNames = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    // Fall back to the static map below.
  }

  try {
    languageDisplayNames = new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    // Fall back to the static map below.
  }

  function handlePointerOver(event) {
    const image = findFlagImage(event.target);
    if (!image) {
      hideFlagTooltip();
      return;
    }

    if (!featureSettings.flagTooltipsEnabled) {
      return;
    }

    showFlagTooltip(image);
  }

  function handlePointerMove(event) {
    if (!tooltipVisible || !activeTooltipAnchor) {
      return;
    }

    const image = findFlagImage(event.target);
    if (image && image === activeTooltipAnchor) {
      positionFlagTooltip(image);
    }
  }

  function handlePointerOut(event) {
    if (!featureSettings.flagTooltipsEnabled || !tooltipVisible || !activeTooltipAnchor) {
      return;
    }

    const fromImage = findFlagImage(event.target);
    if (!fromImage || fromImage !== activeTooltipAnchor) {
      return;
    }

    const relatedTarget = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (relatedTarget && activeTooltipAnchor.contains(relatedTarget)) {
      return;
    }

    scheduleHideTooltip();
  }

  function scheduleHideTooltip() {
    if (tooltipHideTimer) {
      window.clearTimeout(tooltipHideTimer);
    }

    tooltipHideTimer = window.setTimeout(() => {
      hideFlagTooltip();
    }, 50);
  }

  function cancelHideTooltip() {
    if (tooltipHideTimer) {
      window.clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
  }

  function showFlagTooltip(image) {
    if (!featureSettings.flagTooltipsEnabled) {
      hideFlagTooltip();
      return;
    }

    cancelHideTooltip();
    ensureTooltipElement();

    const info = getFlagInfo(image);
    if (!info) {
      hideFlagTooltip();
      return;
    }

    activeTooltipAnchor = image;
    tooltipVisible = true;

    tooltipElement.innerHTML = '';

    const titleRow = document.createElement('div');
    titleRow.className = 'devglobe-flag-tooltip__country';
    titleRow.textContent = info.countryName;

    const languagesRow = document.createElement('div');
    languagesRow.className = 'devglobe-flag-tooltip__languages';
    languagesRow.textContent = info.languageNames.join(', ');

    tooltipElement.append(titleRow, languagesRow);

    tooltipElement.dataset.visible = 'true';
    tooltipElement.setAttribute('aria-hidden', 'false');

    positionFlagTooltip(image);
  }

  function positionFlagTooltip(anchor) {
    if (!tooltipElement || !tooltipVisible) {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const padding = 12;

    tooltipElement.style.left = '0px';
    tooltipElement.style.top = '0px';
    tooltipElement.style.visibility = 'hidden';
    tooltipElement.style.display = 'block';

    const tooltipRect = tooltipElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = anchorRect.left + (anchorRect.width / 2) - (tooltipRect.width / 2);
    left = Math.max(padding, Math.min(left, viewportWidth - tooltipRect.width - padding));

    let top = anchorRect.bottom + 12;
    let placement = 'bottom';

    if (top + tooltipRect.height + padding > viewportHeight) {
      top = anchorRect.top - tooltipRect.height - 12;
      placement = 'top';
    }

    if (top < padding) {
      top = Math.max(padding, viewportHeight - tooltipRect.height - padding);
      placement = top <= anchorRect.top ? 'top' : 'bottom';
    }

    const anchorCenter = anchorRect.left + (anchorRect.width / 2);
    const arrowX = Math.max(18, Math.min(tooltipRect.width - 18, anchorCenter - left));

    tooltipElement.dataset.placement = placement;
    tooltipElement.style.setProperty('--tooltip-arrow-x', `${Math.round(arrowX)}px`);
    tooltipElement.style.left = `${Math.round(left)}px`;
    tooltipElement.style.top = `${Math.round(top)}px`;
    tooltipElement.style.visibility = 'visible';
  }

  function hideFlagTooltip() {
    cancelHideTooltip();
    tooltipVisible = false;
  }

  function applyCommandKeyReplacement() {
    const targetElements = document.querySelectorAll('body *:not(script):not(style)'); // Éviter les scripts et les styles
    targetElements.forEach(element => {
      // Ne traiter que les nœuds de texte directement pour éviter de casser la structure HTML
      element.childNodes.forEach(node => {
        if (node.nodeType === Node.TEXT_NODE) {
          if (featureSettings.replaceCommandKeyEnabled) {
            node.textContent = node.textContent.replace(/⌘/g, 'CTRL');
          } else {
            // Rétablir si cela a été remplacé auparavant
            node.textContent = node.textContent.replace(/CTRL/g, '⌘');
          }
        }
      });
    });
  }

  function ensureTooltipElement() {
    if (tooltipElement) {
      return tooltipElement;
    }

    tooltipElement = document.createElement('div');
    tooltipElement.className = FLAG_TOOLTIP_CLASS;
    tooltipElement.setAttribute('role', 'tooltip');
    tooltipElement.setAttribute('aria-hidden', 'true');
    tooltipElement.dataset.visible = 'false';

    const root = document.body || document.documentElement;
    if (root) {
      root.appendChild(tooltipElement);
    }

    tooltipElement.addEventListener('pointerenter', cancelHideTooltip);
    tooltipElement.addEventListener('pointerleave', hideFlagTooltip);

    return tooltipElement;
  }

  function findFlagImage(target) {
    const element = target instanceof Element ? target : null;
    if (!element) {
      return null;
    }

    const image = element.closest('img[alt]');
    if (!image || !isFlagImage(image)) {
      return null;
    }

    return image;
  }

  const LANGUAGE_FALLBACK_NAMES = {
    kk: 'Kazakh',
    ko: 'Korean',
    ky: 'Kyrgyz',
    lb: 'Luxembourgish',
    mk: 'Macedonian',
    ms: 'Malay',
    mt: 'Maltese',
    nb: 'Norwegian Bokmal',
    ne: 'Nepali',
    nl: 'Dutch',
    no: 'Norwegian',
    pl: 'Polish',
    pt: 'Portuguese',
    ro: 'Romanian',
    ru: 'Russian',
    si: 'Sinhala',
    sk: 'Slovak',
    sl: 'Slovenian',
    sq: 'Albanian',
    sr: 'Serbian',
    sv: 'Swedish',
    sw: 'Swahili',
    ta: 'Tamil',
    tg: 'Tajik',
    th: 'Thai',
    tr: 'Turkish',
    tzm: 'Central Atlas Tamazight',
    uk: 'Ukrainian',
    ur: 'Urdu',
    uz: 'Uzbek',
    vi: 'Vietnamese',
    xh: 'Xhosa',
    yo: 'Yoruba',
    zh: 'Chinese',
    zu: 'Zulu',
    rm: 'Romansh',
    fil: 'Filipino'
  };

  const COUNTRY_LANGUAGE_CODES = {
    AD: ['ca'],
    AE: ['ar'],
    AF: ['ps', 'fa'],
    AL: ['sq'],
    AM: ['hy', 'ru'],
    AO: ['pt'],
    AR: ['es'],
    AT: ['de'],
    AU: ['en'],
    AZ: ['az', 'ru'],
    BA: ['bs', 'hr', 'sr'],
    BD: ['bn'],
    BE: ['nl', 'fr', 'de'],
    BG: ['bg'],
    BH: ['ar'],
    BO: ['es', 'qu', 'ay'],
    BR: ['pt'],
    BS: ['en'],
    BW: ['en', 'tn'],
    BY: ['be', 'ru'],
    CA: ['en', 'fr'],
    CH: ['de', 'fr', 'it', 'rm'],
    CL: ['es'],
    CM: ['fr', 'en'],
    CN: ['zh'],
    CO: ['es'],
    CR: ['es'],
    CU: ['es'],
    CY: ['el', 'tr'],
    CZ: ['cs'],
    DE: ['de'],
    DK: ['da'],
    DO: ['es'],
    DZ: ['ar', 'fr'],
    EC: ['es', 'qu'],
    EE: ['et'],
    EG: ['ar'],
    ES: ['es', 'ca', 'eu', 'gl'],
    ET: ['am'],
    FI: ['fi', 'sv'],
    FJ: ['en', 'fj', 'hi'],
    FR: ['fr'],
    GB: ['en'],
    GE: ['ka', 'ru'],
    GH: ['en'],
    GR: ['el'],
    GT: ['es'],
    HK: ['zh', 'en'],
    HN: ['es'],
    HR: ['hr'],
    HT: ['fr', 'ht'],
    HU: ['hu'],
    ID: ['id'],
    IE: ['en', 'ga'],
    IL: ['he', 'ar'],
    IN: ['hi', 'en'],
    IQ: ['ar', 'ku'],
    IR: ['fa'],
    IS: ['is'],
    IT: ['it'],
    JM: ['en'],
    JO: ['ar'],
    JP: ['ja'],
    KE: ['sw', 'en'],
    KG: ['ky', 'ru'],
    KH: ['km'],
    KR: ['ko'],
    KW: ['ar'],
    KZ: ['kk', 'ru'],
    LA: ['lo'],
    LB: ['ar'],
    LI: ['de'],
    LK: ['si', 'ta'],
    LT: ['lt'],
    LU: ['lb', 'fr', 'de'],
    LV: ['lv'],
    LY: ['ar'],
    MA: ['ar', 'fr'],
    MC: ['fr'],
    MD: ['ro', 'ru'],
    ME: ['sr', 'bs', 'hr', 'sq'],
    MK: ['mk'],
    MM: ['my'],
    MN: ['mn'],
    MO: ['zh', 'pt'],
    MT: ['mt', 'en'],
    MX: ['es'],
    MY: ['ms', 'en', 'zh', 'ta'],
    MZ: ['pt'],
    NA: ['en', 'af'],
    NG: ['en'],
    NI: ['es'],
    NL: ['nl'],
    NO: ['no', 'nb', 'nn'],
    NP: ['ne'],
    NZ: ['en', 'mi'],
    OM: ['ar'],
    PA: ['es'],
    PE: ['es', 'qu', 'ay'],
    PH: ['en', 'tl'],
    PK: ['ur', 'en'],
    PL: ['pl'],
    PR: ['es', 'en'],
    PT: ['pt'],
    PY: ['es', 'gn'],
    QA: ['ar'],
    RO: ['ro'],
    RS: ['sr'],
    RU: ['ru'],
    RW: ['rw', 'en', 'fr'],
    SA: ['ar'],
    SE: ['sv'],
    SG: ['en', 'ms', 'zh', 'ta'],
    SI: ['sl'],
    SK: ['sk'],
    SN: ['fr'],
    SV: ['es'],
    TH: ['th'],
    TJ: ['tg', 'ru'],
    TM: ['tk', 'ru'],
    TN: ['ar', 'fr'],
    TR: ['tr'],
    TT: ['en'],
    TW: ['zh'],
    TZ: ['sw', 'en'],
    UA: ['uk'],
    UG: ['en', 'sw'],
    US: ['en'],
    UY: ['es'],
    UZ: ['uz', 'ru'],
    VE: ['es'],
    VN: ['vi'],
    WS: ['en', 'sm'],
    ZA: ['en', 'af', 'zu', 'xh'],
    ZM: ['en'],
    ZW: ['en', 'sn', 'nd']
  };

  const REPOSITORY_HOSTS = new Set([
    'bitbucket.org',
    'codeberg.org',
    'forgejo.org',
    'framagit.org',
    'gitea.com',
    'git.sr.ht',
    'gitlab.com',
    'gitlab.freedesktop.org',
    'gitlab.gnome.org',
    'github.com',
    'invent.kde.org',
    'notabug.org',
    'salsa.debian.org',
    'sourcehut.org',
    'sr.ht'
  ]);

  const NON_REPOSITORY_FIRST_SEGMENTS = new Set([
    'about',
    'collections',
    'dashboard',
    'discover',
    'explore',
    'features',
    'help',
    'join',
    'login',
    'logout',
    'marketplace',
    'notifications',
    'orgs',
    'organizations',
    'pricing',
    'projects',
    'search',
    'settings',
    'sponsors',
    'topics',
    'users'
  ]);

  initialize();

  async function initialize() {
    await loadInitialCache();
    await loadFeatureSettings();
    installObservers();
    installEventHandlers();
    installStorageListeners();
    installMessageListeners();
    scheduleScan();
    scanIntervalId = window.setInterval(scheduleScan, SCAN_INTERVAL_MS);
  }

  async function loadInitialCache() {
    if (cacheReadyPromise) {
      return cacheReadyPromise;
    }

    cacheReadyPromise = sendMessage({ type: 'devglobe:get-cache-snapshot' })
      .then((response) => {
        repositoryStateCache.clear();

        if (response && Array.isArray(response.entries)) {
          for (const entry of response.entries) {
            const normalizedEntry = normalizeRepositoryState(entry);
            if (normalizedEntry) {
              repositoryStateCache.set(normalizedEntry.url, normalizedEntry);
            }
          }
        }

        return repositoryStateCache;
      })
      .catch(() => repositoryStateCache);

    return cacheReadyPromise;
  }

  async function loadFeatureSettings() {
    const stored = await chrome.storage.local.get(FEATURE_SETTINGS_KEY);
    featureSettings = normalizeFeatureSettings(stored[FEATURE_SETTINGS_KEY]);
    return featureSettings;
  }

  function normalizeFeatureSettings(rawSettings) {
    return {
      flagTooltipsEnabled: typeof rawSettings?.flagTooltipsEnabled === 'boolean'
        ? rawSettings.flagTooltipsEnabled
        : DEFAULT_FEATURE_SETTINGS.flagTooltipsEnabled,
      repositoryBlockingEnabled: typeof rawSettings?.repositoryBlockingEnabled === 'boolean'
        ? rawSettings.repositoryBlockingEnabled
        : DEFAULT_FEATURE_SETTINGS.repositoryBlockingEnabled,
      statsTableSortingEnabled: typeof rawSettings?.statsTableSortingEnabled === 'boolean'
        ? rawSettings.statsTableSortingEnabled
        : DEFAULT_FEATURE_SETTINGS.statsTableSortingEnabled,
      searchKeyboardShortcutEnabled: typeof rawSettings?.searchKeyboardShortcutEnabled === 'boolean'
        ? rawSettings.searchKeyboardShortcutEnabled
        : DEFAULT_FEATURE_SETTINGS.searchKeyboardShortcutEnabled,
      dropdownNavigationEnabled: typeof rawSettings?.dropdownNavigationEnabled === 'boolean'
        ? rawSettings.dropdownNavigationEnabled
        : DEFAULT_FEATURE_SETTINGS.dropdownNavigationEnabled,
      escapeKeyClosesModals: typeof rawSettings?.escapeKeyClosesModals === 'boolean'
        ? rawSettings.escapeKeyClosesModals
        : DEFAULT_FEATURE_SETTINGS.escapeKeyClosesModals,
      replaceCommandKeyEnabled: typeof rawSettings?.replaceCommandKeyEnabled === 'boolean'
        ? rawSettings.replaceCommandKeyEnabled
        : DEFAULT_FEATURE_SETTINGS.replaceCommandKeyEnabled
    };
  }

  function installStorageListeners() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[FEATURE_SETTINGS_KEY]) {
        return;
      }

      applyFeatureSettings(changes[FEATURE_SETTINGS_KEY].newValue);
    });
  }

  function applyFeatureSettings(rawSettings) {
    const previousSettings = featureSettings;
    featureSettings = normalizeFeatureSettings(rawSettings);

    if (!featureSettings.flagTooltipsEnabled) {
      hideFlagTooltip();
      clearFlagVisualState();
    }

    if (!featureSettings.repositoryBlockingEnabled) {
      clearRepositoryVisualState();
    }

    if (
      previousSettings.flagTooltipsEnabled !== featureSettings.flagTooltipsEnabled
      || previousSettings.repositoryBlockingEnabled !== featureSettings.repositoryBlockingEnabled
      || previousSettings.statsTableSortingEnabled !== featureSettings.statsTableSortingEnabled
      || previousSettings.dropdownNavigationEnabled !== featureSettings.dropdownNavigationEnabled
      || previousSettings.escapeKeyClosesModals !== featureSettings.escapeKeyClosesModals
      || previousSettings.replaceCommandKeyEnabled !== featureSettings.replaceCommandKeyEnabled
    ) {
      scheduleScan();
    }
  }

  function installObservers() {
    const root = document.documentElement || document.body;
    if (!root) {
      return;
    }

    mutationObserver = new MutationObserver(() => {
      scheduleScan();
    });

    mutationObserver.observe(root, {
      childList: true,
      subtree: true
    });
  }

  function installEventListeners() {
    document.addEventListener('pointerover', handlePointerOver, true);
    document.addEventListener('pointermove', handlePointerMove, true);
    document.addEventListener('pointerout', handlePointerOut, true);
    document.addEventListener('click', handleClick, true);
    document.addEventListener('keydown', handleSearchKeyboardShortcut, true);
    document.addEventListener('keydown', handleDropdownNavigation, true);
    document.addEventListener('keydown', handleEscapeKey, true);
    window.addEventListener('scroll', hideFlagTooltip, true);
    window.addEventListener('blur', hideFlagTooltip, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hideFlagTooltip();
      }
    });
  }

  function handleSearchKeyboardShortcut(event) {
    if (!featureSettings.searchKeyboardShortcutEnabled) {
      return;
    }
    // Ignore if a modifier key is held (Ctrl, Alt, Meta)
    if (event.ctrlKey || event.altKey || event.metaKey) {
      return;
    }
    // Only handle single printable character keys (letters including accented, digits, hyphen, underscore)
    if (event.key.length !== 1 || !/[\p{L}\p{N}_-]/u.test(event.key)) {
      return;
    }
    // Ignore if already typing in an input, textarea, or contenteditable element
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable)) {
      return;
    }
    // Find the search input based on the current page
    const searchInput = findSearchInput();
    if (searchInput) {
      event.preventDefault();
      searchInput.focus();
      // Insert the typed character into the search input
      const start = searchInput.selectionStart;
      const end = searchInput.selectionEnd;
      const value = searchInput.value;
      searchInput.value = value.slice(0, start) + event.key + value.slice(end);
      searchInput.selectionStart = searchInput.selectionEnd = start + 1;
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function findSearchInput() {
    const pathname = window.location.pathname;
    if (pathname.startsWith('/space')) {
      return document.querySelector('div.absolute.z-\\[600\\] input[placeholder="Search developers..."]');
    }
    if (pathname.startsWith('/plugins')) {
      return document.querySelector('input[placeholder="Search plugins..."]');
    }
    if (pathname.startsWith('/projects')) {
      return document.querySelector('input[placeholder="Search projects..."]');
    }
    if (pathname.startsWith('/developers')) {
      return document.querySelector('input[placeholder="Search developers..."]');
    }
    return null;
  }

  let dropdownSelectedIndex = -1;

  function handleDropdownNavigation(event) {
    if (!featureSettings.dropdownNavigationEnabled) {
      return;
    }

    const searchInput = findSearchInput();
    if (!searchInput || document.activeElement !== searchInput) {
      return;
    }

    // Find the dropdown container — it's the next sibling element after the search input's parent
    const searchParent = searchInput.closest('div.relative');
    if (!searchParent) {
      return;
    }

    const dropdown = searchParent.querySelector('div.mt-1\\.5');
    if (!dropdown) {
      return;
    }

    const items = dropdown.querySelectorAll('button');
    if (items.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      dropdownSelectedIndex = updateDropdownSelection(items, dropdownSelectedIndex, 'down');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      dropdownSelectedIndex = updateDropdownSelection(items, dropdownSelectedIndex, 'up');
    } else if (event.key === 'Enter' && dropdownSelectedIndex >= 0 && dropdownSelectedIndex < items.length) {
      event.preventDefault();
      items[dropdownSelectedIndex].click();
      dropdownSelectedIndex = -1;
    } else if (event.key === 'Escape') {
      dropdownSelectedIndex = -1;
    }
  }

  function updateDropdownSelection(items, currentIndex, direction) {
    let newIndex;
    if (direction === 'down') {
      if (currentIndex < 0 || currentIndex >= items.length - 1) {
        newIndex = 0;
      } else {
        newIndex = currentIndex + 1;
      }
    } else {
      if (currentIndex <= 0 || currentIndex >= items.length) {
        newIndex = items.length - 1;
      } else {
        newIndex = currentIndex - 1;
      }
    }

    // Remove selection from all items
    items.forEach((item) => {
      item.classList.remove('bg-pj-hover');
    });

    // Add selection to the new item
    items[newIndex].classList.add('bg-pj-hover');
    items[newIndex].scrollIntoView({ block: 'nearest' });

    return newIndex;
  }

  function handleEscapeKey(event) {
    if (!featureSettings.escapeKeyClosesModals) {
      return;
    }
    // Only handle Escape key
    if (event.key !== 'Escape') {
      return;
    }
    
    // Priority 1: MapLibre popup
    const mapLibrePopup = document.querySelector('.maplibregl-popup');
    if (mapLibrePopup) {
        const closeButton = mapLibrePopup.querySelector('.maplibregl-popup-close-button');
        if (closeButton) {
            closeButton.click();
            return; // Stop here - never close both
        }
    }
    
    // Priority 2: Profile panel (only if MapLibre popup not found)
    const profilePanel = document.querySelector('[data-panel="true"]');
    if (profilePanel) {
        const closeButton = profilePanel.querySelector('button:has(svg path[d*="M18 6L6"])');
        if (closeButton) {
            closeButton.click();
        }
    }
  }

  function installEventHandlers() {
    installEventListeners();
  }

  function installMessageListeners() {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || typeof message.type !== 'string') {
        return;
      }

      if (message.type === 'devglobe:repository-state-updated') {
        const state = normalizeRepositoryState(message.state);
        if (state) {
          repositoryStateCache.set(state.url, state);
          applyRepositoryStateToMatchingLinks(state);
          if (activeTooltipAnchor && getAnchorUrl(activeTooltipAnchor) === state.url) {
            void ensureRepositoryStateForAnchor(activeTooltipAnchor, { forceFresh: false });
          }
        }
        return;
      }

      if (message.type === 'devglobe:cache-cleared') {
        repositoryStateCache.clear();
        clearRepositoryVisualState();
      }
    });
  }

  function scheduleScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;

    window.requestAnimationFrame(() => {
      scanQueued = false;
      scanDocument();
    });
  }

  function scanDocument() {
    if (featureSettings.flagTooltipsEnabled) {
      document.querySelectorAll('img[alt]').forEach((image) => {
        if (isFlagImage(image)) {
          enhanceFlagImage(image);
        } else if (image.dataset.devglobeFlagReady === 'true') {
          restoreFlagImage(image);
        }
      });
    } else {
      clearFlagVisualState();
    }

    if (featureSettings.repositoryBlockingEnabled) {
      document.querySelectorAll('a[href]').forEach((anchor) => {
        if (isRepositoryLink(anchor)) {
          void ensureRepositoryStateForAnchor(anchor, { forceFresh: false });
        }
      });
    } else {
      clearRepositoryVisualState();
    }

    if (isStatsPage()) {
      enhanceStatsTables();
    }
    if (featureSettings.replaceCommandKeyEnabled) {
      replaceCommandKeyInDOM();
    }
  }

  function replaceCommandKeyInDOM() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      { acceptNode: (node) => node.nodeValue.includes('⌘') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT }
    );
    
    let node;
    while ((node = walker.nextNode())) {
      node.nodeValue = node.nodeValue.replace(/⌘/g, 'CTRL');
    }
  }

  function enhanceStatsTables() {
    const tables = document.querySelectorAll('table');

    tables.forEach((table) => {
      const config = getStatsTableConfig(table);
      if (!config) {
        return;
      }

      const state = getOrCreateStatsTableState(table, config);
      captureStatsTableBaseline(table, state);
      setupStatsTableControls(table, config, state);

      if (!featureSettings.statsTableSortingEnabled) {
        restoreStatsTableOriginalOrder(table, state);
        state.activeColumnKey = state.initialColumnKey;
        state.activeDirection = state.initialDirection;
        updateStatsTableSortIndicators(table, config, state);
        return;
      }

      if (state.activeColumnKey && state.activeDirection) {
        applyStatsTableSort(table, config, state, state.activeColumnKey, state.activeDirection);
        return;
      }

      updateStatsTableSortIndicators(table, config, state);
    });
  }

  function getStatsTableConfig(table) {
    const tableKey = getStatsTableKey(table);
    if (!tableKey) {
      return null;
    }

    const sortableHeaders = Array.from(table.querySelectorAll('thead th'))
      .map((cell, index) => {
        const label = getStatsHeaderLabel(cell);
        const columnKey = normalizeStatsColumnKey(label);

        if (!STATS_SORTABLE_COLUMN_LABELS.has(columnKey)) {
          return null;
        }

        return {
          cell,
          index,
          label,
          columnKey
        };
      })
      .filter(Boolean);

    if (!sortableHeaders.length) {
      return null;
    }

    return {
      tableKey,
      sortableHeaders
    };
  }

  function getOrCreateStatsTableState(table, config) {
    const existingState = statsTableSortStateByKey.get(config.tableKey);
    if (existingState) {
      if (!existingState.initialColumnKey && !existingState.initialDirection) {
        populateInitialStatsTableState(table, config, existingState);
      }

      if (typeof existingState.initialSortPending !== 'boolean') {
        existingState.initialSortPending = Boolean(existingState.initialColumnKey && existingState.initialDirection);
      }

      return existingState;
    }

    const state = {
      initialColumnKey: null,
      initialDirection: null,
      activeColumnKey: null,
      activeDirection: null,
      initialSortPending: false,
      columnDirections: new Map(),
      originalRows: []
    };

    populateInitialStatsTableState(table, config, state);
    state.initialSortPending = Boolean(state.initialColumnKey && state.initialDirection);

    statsTableSortStateByKey.set(config.tableKey, state);
    return state;
  }

  function populateInitialStatsTableState(table, config, state) {
    const tbody = table.tBodies[0];
    const rows = tbody ? Array.from(tbody.rows) : [];

    if (rows.length >= 2) {
      for (const header of config.sortableHeaders) {
        const detectedDirection = detectStatsColumnDirection(rows, header.index);
        if (!detectedDirection) {
          continue;
        }

        if (!state.initialColumnKey) {
          state.initialColumnKey = header.columnKey;
          state.initialDirection = detectedDirection;
        }

        state.columnDirections.set(header.columnKey, detectedDirection);

        if (!state.activeColumnKey) {
          state.activeColumnKey = header.columnKey;
          state.activeDirection = detectedDirection;
        }
      }
    }
  }

  function captureStatsTableBaseline(table, state) {
    const tbody = table.tBodies[0];
    if (!tbody) {
      return;
    }

    const hasValidBaseline = state.originalRows.length > 0
      && state.originalRows.every((row) => row.parentElement === tbody);

    if (hasValidBaseline) {
      return;
    }

    state.originalRows = Array.from(tbody.rows);
  }

  function restoreStatsTableOriginalOrder(table, state) {
    const tbody = table.tBodies[0];
    if (!tbody) {
      return;
    }

    if (state.originalRows.length === 0 || !state.originalRows.every((row) => row.parentElement === tbody)) {
      captureStatsTableBaseline(table, state);
    }

    if (state.originalRows.length === 0) {
      return;
    }

    const currentRows = Array.from(tbody.rows);
    const isAlreadyBaseline = currentRows.length === state.originalRows.length
      && currentRows.every((row, index) => row === state.originalRows[index]);

    if (isAlreadyBaseline) {
      renumberStatsRows(tbody);
      return;
    }

    const fragment = document.createDocumentFragment();
    state.originalRows.forEach((row) => {
      if (row.parentElement === tbody) {
        fragment.appendChild(row);
      }
    });

    tbody.appendChild(fragment);
    renumberStatsRows(tbody);
  }

  function detectStatsColumnDirection(rows, columnIndex) {
    const values = [];

    for (const row of rows) {
      const value = getStatsSortableNumber(row.cells[columnIndex] || null);
      if (value === null) {
        return null;
      }

      values.push(value);
    }

    if (values.length < 2) {
      return null;
    }

    const isAscending = values.every((value, index) => index === 0 || values[index - 1] <= value);
    const isDescending = values.every((value, index) => index === 0 || values[index - 1] >= value);

    if (isAscending && !isDescending) {
      return 'asc';
    }

    if (isDescending && !isAscending) {
      return 'desc';
    }

    return null;
  }

  function setupStatsTableControls(table, config, state) {
    config.sortableHeaders.forEach(({ cell, columnKey, label }) => {
      const existingButton = cell.querySelector('[data-devglobe-stats-sort-button="true"]');
      cell.dataset.devglobeStatsSortLabel = label;
      cell.dataset.devglobeStatsSortColumn = columnKey;
      cell.classList.add(STATS_SORTABLE_HEADER_CLASS);

      if (existingButton) {
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = STATS_SORT_BUTTON_CLASS;
      button.setAttribute('aria-label', `Sort by ${label}`);
      button.dataset.devglobeStatsSortButton = 'true';

      const labelSpan = document.createElement('span');
      labelSpan.className = 'devglobe-stats-sort-label';
      labelSpan.textContent = label;

      const arrowSpan = document.createElement('span');
      arrowSpan.className = STATS_SORT_ARROW_CLASS;
      arrowSpan.dataset.devglobeStatsSortArrow = 'true';
      arrowSpan.dataset.visible = 'false';
      arrowSpan.setAttribute('aria-hidden', 'true');
      arrowSpan.appendChild(createStatsSortArrowIcon());

      button.append(labelSpan, arrowSpan);
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (!featureSettings.statsTableSortingEnabled) {
          return;
        }

        const rememberedDirection = state.columnDirections.get(columnKey);
        const isInitialColumnFirstClick = state.initialSortPending
          && state.initialColumnKey === columnKey
          && state.activeColumnKey === columnKey
          && state.activeDirection === state.initialDirection;

        const nextDirection = isInitialColumnFirstClick
          ? state.initialDirection
          : state.activeColumnKey === columnKey
          ? (state.activeDirection === 'desc' ? 'asc' : 'desc')
          : (rememberedDirection || 'desc');

        applyStatsTableSort(table, config, state, columnKey, nextDirection);
      });

      cell.replaceChildren(button);
    });
  }

  function applyStatsTableSort(table, config, state, columnKey, direction) {
    if (!featureSettings.statsTableSortingEnabled) {
      return;
    }

    const targetHeader = config.sortableHeaders.find((header) => header.columnKey === columnKey);
    if (!targetHeader) {
      return;
    }

    const tbody = table.tBodies[0];
    if (!tbody) {
      return;
    }

    const hoursHeader = config.sortableHeaders.find((header) => header.columnKey === 'hours');
    const hoursColumnIndex = hoursHeader ? hoursHeader.index : -1;

    const rows = Array.from(tbody.rows);
    if (rows.length < 2) {
      if (state.initialColumnKey === columnKey && direction === state.initialDirection) {
        state.initialSortPending = false;
      }

      state.columnDirections.set(columnKey, direction);
      state.activeColumnKey = columnKey;
      state.activeDirection = direction;
      updateStatsTableSortIndicators(table, config, state);
      renumberStatsRows(tbody);
      return;
    }

    const sortedRows = rows
      .map((row, index) => {
        const valueCell = row.cells[targetHeader.index] || null;
        const growthText = normalizeStatsText(valueCell?.textContent || '').toLowerCase();
        const isNewGrowthValue = columnKey === 'growth' && growthText === 'new';
        const value = isNewGrowthValue ? null : getStatsSortableNumber(valueCell);
        const rankValue = getStatsSortableNumber(row.cells[0] || null);
        const hoursValue = hoursColumnIndex >= 0
          ? getStatsSortableNumber(row.cells[hoursColumnIndex] || null)
          : null;

        return {
          row,
          value,
          isNewGrowthValue,
          hoursValue: Number.isFinite(hoursValue) ? hoursValue : null,
          originalRank: Number.isFinite(rankValue) ? rankValue : index + 1
        };
      })
      .sort((left, right) => {
        if (columnKey === 'growth') {
          if (left.isNewGrowthValue !== right.isNewGrowthValue) {
            return direction === 'asc'
              ? (left.isNewGrowthValue ? 1 : -1)
              : (left.isNewGrowthValue ? -1 : 1);
          }

          if (left.isNewGrowthValue && right.isNewGrowthValue) {
            if (left.hoursValue === null && right.hoursValue !== null) {
              return 1;
            }

            if (left.hoursValue !== null && right.hoursValue === null) {
              return -1;
            }

            if (left.hoursValue !== right.hoursValue) {
              return direction === 'asc'
                ? left.hoursValue - right.hoursValue
                : right.hoursValue - left.hoursValue;
            }

            return left.originalRank - right.originalRank;
          }
        }

        if (left.value === null && right.value === null) {
          return left.originalRank - right.originalRank;
        }

        if (left.value === null) {
          return 1;
        }

        if (right.value === null) {
          return -1;
        }

        if (left.value !== right.value) {
          return direction === 'asc'
            ? left.value - right.value
            : right.value - left.value;
        }

        return left.originalRank - right.originalRank;
      })
      .map((entry) => entry.row);

    if (state.initialColumnKey === columnKey && direction === state.initialDirection) {
      state.initialSortPending = false;
    }

    state.columnDirections.set(columnKey, direction);
    state.activeColumnKey = columnKey;
    state.activeDirection = direction;

    updateStatsTableSortIndicators(table, config, state);

    const isSameOrder = sortedRows.length === rows.length && sortedRows.every((row, index) => row === rows[index]);
    if (isSameOrder) {
      renumberStatsRows(tbody);
      return;
    }

    const fragment = document.createDocumentFragment();
    sortedRows.forEach((row) => {
      fragment.appendChild(row);
    });

    tbody.appendChild(fragment);
    renumberStatsRows(tbody);
  }

  function renumberStatsRows(tbody) {
    Array.from(tbody.rows).forEach((row, index) => {
      const rankCell = row.cells[0];
      if (rankCell) {
        rankCell.textContent = String(index + 1);
      }
    });
  }

  function updateStatsTableSortIndicators(table, config, state) {
    const sortingEnabled = featureSettings.statsTableSortingEnabled;

    config.sortableHeaders.forEach(({ cell, columnKey, label }) => {
      const button = cell.querySelector('[data-devglobe-stats-sort-button="true"]');
      const arrow = cell.querySelector('[data-devglobe-stats-sort-arrow="true"]');
      const isActive = sortingEnabled
        && state.activeColumnKey === columnKey
        && (state.activeDirection === 'asc' || state.activeDirection === 'desc');

      cell.setAttribute('aria-sort', isActive
        ? state.activeDirection === 'asc'
          ? 'ascending'
          : 'descending'
        : 'none');

      if (button) {
        button.setAttribute('aria-disabled', sortingEnabled ? 'false' : 'true');
        button.setAttribute('aria-label', isActive
          ? `Sort by ${label}, ${state.activeDirection === 'asc' ? 'ascending' : 'descending'}`
          : `Sort by ${label}`);
      }

      if (arrow) {
        arrow.dataset.visible = isActive ? 'true' : 'false';

        if (isActive) {
          arrow.dataset.direction = state.activeDirection;
        } else {
          arrow.removeAttribute('data-direction');
        }
      }
    });
  }

  function getStatsTableKey(table) {
    const caption = table.querySelector('caption');
    const captionText = normalizeStatsText(caption?.textContent || '');
    if (captionText) {
      return captionText;
    }

    const section = table.closest('section');
    if (!section) {
      return '';
    }

    const heading = section.querySelector('header h1, header h2, header h3, header h4, header h5, header h6');
    return normalizeStatsText(heading?.textContent || '');
  }

  function getStatsHeaderLabel(cell) {
    return normalizeStatsText(cell.dataset.devglobeStatsSortLabel || cell.textContent || '');
  }

  function normalizeStatsColumnKey(value) {
    return normalizeStatsText(value).toLowerCase();
  }

  function normalizeStatsText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getStatsSortableNumber(cell) {
    if (!cell) {
      return null;
    }

    const text = normalizeStatsText(cell.textContent || '');
    if (!text) {
      return null;
    }

    const numericText = text.replace(/,/g, '').replace(/[^0-9.-]/g, '');
    if (!numericText) {
      return null;
    }

    const numeric = Number.parseFloat(numericText);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function createStatsSortArrowIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M7 14l5-5 5 5');
    svg.appendChild(path);

    return svg;
  }

  function isStatsPage() {
    return window.location.pathname.toLowerCase().replace(/\/+$/, '') === '/stats';
  }

  function clearFlagVisualState() {
    document.querySelectorAll('img[data-devglobe-flag-ready="true"]').forEach((image) => {
      restoreFlagImage(image);
    });
  }

  function enhanceFlagImage(image) {
    if (!featureSettings.flagTooltipsEnabled) {
      restoreFlagImage(image);
      return;
    }

    const info = getFlagInfo(image);
    if (!info) {
      if (image.dataset.devglobeFlagReady === 'true') {
        restoreFlagImage(image);
      }

      return;
    }

    if (!Object.prototype.hasOwnProperty.call(image.dataset, 'devglobeOriginalTitle')) {
      image.dataset.devglobeOriginalTitle = image.getAttribute('title') || '';
    }

    image.classList.add(FLAG_CLASS);
    image.dataset.devglobeFlagReady = 'true';
    image.dataset.devglobeCountryName = info.countryName;
    image.dataset.devglobeLanguageList = info.languageNames.join(', ');
    image.removeAttribute('title');
  }

  function restoreFlagImage(image) {
    image.classList.remove(FLAG_CLASS);
    image.removeAttribute('data-devglobe-flag-ready');
    image.removeAttribute('data-devglobe-country-name');
    image.removeAttribute('data-devglobe-language-list');

    if (Object.prototype.hasOwnProperty.call(image.dataset, 'devglobeOriginalTitle')) {
      const originalTitle = image.dataset.devglobeOriginalTitle;
      if (originalTitle) {
        image.setAttribute('title', originalTitle);
      } else {
        image.removeAttribute('title');
      }

      delete image.dataset.devglobeOriginalTitle;
    }
  }

  function isFlagImage(image) {
    const alt = (image.getAttribute('alt') || '').trim();
    if (!/^[A-Za-z]{2}$/.test(alt)) {
      return false;
    }

    const sourceText = `${image.getAttribute('src') || ''} ${image.getAttribute('srcset') || ''}`.toLowerCase();
    if (sourceText.includes('flagcdn.com')) {
      return true;
    }

    const widthValue = Number(image.getAttribute('width') || '0');
    if (widthValue > 0 && widthValue <= 20) {
      return true;
    }

    return false;
  }

  function getFlagInfo(image) {
    const countryCode = (image.getAttribute('alt') || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(countryCode)) {
      return null;
    }

    const countryName = getCountryName(countryCode);
    const languageCodes = COUNTRY_LANGUAGE_CODES[countryCode] || [];
    const languageNames = languageCodes
      .map((languageCode) => getLanguageName(languageCode))
      .filter(Boolean);

    const resolvedLanguageNames = languageNames.length > 0
      ? languageNames
      : languageCodes.length > 0
        ? languageCodes.map((languageCode) => languageCode.toUpperCase())
        : ['Unknown'];

    return {
      countryCode,
      countryName,
      languageCodes,
      languageNames: resolvedLanguageNames
    };
  }

  function getCountryName(countryCode) {
    if (countryDisplayNames) {
      try {
        const regionName = countryDisplayNames.of(countryCode);
        if (regionName) {
          return regionName;
        }
      } catch (error) {
        // Fall back to the static map below.
      }
    }

    return countryCode;
  }

  function getLanguageName(languageCode) {
    const normalizedLanguageCode = languageCode.trim().toLowerCase();

    if (languageDisplayNames) {
      try {
        const languageName = languageDisplayNames.of(normalizedLanguageCode);
        if (languageName) {
          return capitalize(languageName);
        }
      } catch (error) {
        // Fall back to the static map below.
      }
    }

    return LANGUAGE_FALLBACK_NAMES[normalizedLanguageCode] || normalizedLanguageCode.toUpperCase();
  }

  function capitalize(value) {
    if (!value) {
      return value;
    }

    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  async function handleClick(event) {
    if (!featureSettings.repositoryBlockingEnabled) {
      return;
    }

    const anchor = findRepositoryAnchor(event.target);
    if (!anchor) {
      return;
    }

    if (repositoryNavigationReplay.has(anchor)) {
      repositoryNavigationReplay.delete(anchor);

  const COUNTRY_LANGUAGE_CODES = {
    AD: ['ca'],
    AE: ['ar'],
    AF: ['ps', 'fa'],
    AL: ['sq'],
    AM: ['hy', 'ru'],
    AO: ['pt'],
    AR: ['es'],
    AT: ['de'],
    AU: ['en'],
    AZ: ['az', 'ru'],
    BA: ['bs', 'hr', 'sr'],
    BD: ['bn'],
    BE: ['nl', 'fr', 'de'],
    BG: ['bg'],
    BH: ['ar'],
    BO: ['es', 'qu', 'ay'],
    BR: ['pt'],
    BS: ['en'],
    BW: ['en', 'tn'],
    BY: ['be', 'ru'],
    CA: ['en', 'fr'],
    CH: ['de', 'fr', 'it', 'rm'],
    CL: ['es'],
    CM: ['fr', 'en'],
    CN: ['zh'],
    CO: ['es'],
    CR: ['es'],
    CU: ['es'],
    CY: ['el', 'tr'],
    CZ: ['cs'],
    DE: ['de'],
    DK: ['da'],
    DO: ['es'],
    DZ: ['ar', 'fr'],
    EC: ['es', 'qu'],
    EE: ['et'],
    EG: ['ar'],
    ES: ['es', 'ca', 'eu', 'gl'],
    ET: ['am'],
    FI: ['fi', 'sv'],
    FJ: ['en', 'fj', 'hi'],
    FR: ['fr'],
    GB: ['en'],
    GE: ['ka', 'ru'],
    GH: ['en'],
    GR: ['el'],
    GT: ['es'],
    HK: ['zh', 'en'],
    HN: ['es'],
    HR: ['hr'],
    HT: ['fr', 'ht'],
    HU: ['hu'],
    ID: ['id'],
    IE: ['en', 'ga'],
    IL: ['he', 'ar'],
    IN: ['hi', 'en'],
    IQ: ['ar', 'ku'],
    IR: ['fa'],
    IS: ['is'],
    IT: ['it'],
    JM: ['en'],
    JO: ['ar'],
    JP: ['ja'],
    KE: ['sw', 'en'],
    KG: ['ky', 'ru'],
    KH: ['km'],
    KR: ['ko'],
    KW: ['ar'],
    KZ: ['kk', 'ru'],
    LA: ['lo'],
    LB: ['ar'],
    LI: ['de'],
    LK: ['si', 'ta'],
    LT: ['lt'],
    LU: ['lb', 'fr', 'de'],
    LV: ['lv'],
    LY: ['ar'],
    MA: ['ar', 'fr'],
    MC: ['fr'],
    MD: ['ro', 'ru'],
    ME: ['sr', 'bs', 'hr', 'sq'],
    MK: ['mk'],
    MM: ['my'],
    MN: ['mn'],
    MO: ['zh', 'pt'],
    MT: ['mt', 'en'],
    MX: ['es'],
    MY: ['ms', 'en', 'zh', 'ta'],
    MZ: ['pt'],
    NA: ['en', 'af'],
    NG: ['en'],
    NI: ['es'],
    NL: ['nl'],
    NO: ['no', 'nb', 'nn'],
    NP: ['ne'],
    NZ: ['en', 'mi'],
    OM: ['ar'],
    PA: ['es'],
    PE: ['es', 'qu', 'ay'],
    PH: ['en', 'tl'],
    PK: ['ur', 'en'],
    PL: ['pl'],
    PR: ['es', 'en'],
    PT: ['pt'],
    PY: ['es', 'gn'],
    QA: ['ar'],
    RO: ['ro'],
    RS: ['sr'],
    RU: ['ru'],
    RW: ['rw', 'en', 'fr'],
    SA: ['ar'],
    SE: ['sv'],
    SG: ['en', 'ms', 'zh', 'ta'],
    SI: ['sl'],
    SK: ['sk'],
    SN: ['fr'],
    SV: ['es'],
    TH: ['th'],
    TJ: ['tg', 'ru'],
    TM: ['tk', 'ru'],
    TN: ['ar', 'fr'],
    TR: ['tr'],
    TT: ['en'],
    TW: ['zh'],
    TZ: ['sw', 'en'],
    UA: ['uk'],
    UG: ['en', 'sw'],
    US: ['en'],
    UY: ['es'],
    UZ: ['uz', 'ru'],
    VE: ['es'],
    VN: ['vi'],
    WS: ['en', 'sm'],
    ZA: ['en', 'af', 'zu', 'xh'],
    ZM: ['en'],
    ZW: ['en', 'sn', 'nd']
  };
      event.stopImmediatePropagation();
      return;
    }

    const url = getAnchorUrl(anchor);
    if (!url) {
      return;
    }

    const cachedState = getCachedRepositoryState(url);

    if (cachedState && !isRepositoryStateFresh(cachedState)) {
      const openInNewTab = (anchor.getAttribute('target') || '').trim() === '_blank';
      event.preventDefault();
      event.stopImmediatePropagation();

      const resolved = await requestRepositoryState(url, { forceFresh: true });
      const decisionState = chooseDecisionState(cachedState, resolved);
      applyRepositoryState(anchor, decisionState);

      if (decisionState.state !== 'blocked') {
        openRepositoryUrl(anchor, url);
      }
      return;
    }

    if (cachedState) {
      const openInNewTab = (anchor.getAttribute('target') || '').trim() === '_blank';
      event.preventDefault();
      event.stopImmediatePropagation();

      applyRepositoryState(anchor, cachedState);
      if (cachedState.state !== 'blocked') {
        if (openInNewTab) {
          openRepositoryUrl(anchor, url);
        } else {
          window.location.assign(url.toString());
        }
      }
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const resolvedState = await requestRepositoryState(url, { forceFresh: true });
    applyRepositoryState(anchor, resolvedState);

    if (resolvedState.state !== 'blocked') {
      openRepositoryUrl(anchor, url);
    }
  }

  function openRepositoryUrl(anchor, url) {
    const target = (anchor.getAttribute('target') || '').trim();
    const openInNewTab = target === '_blank';

    if (openInNewTab) {
      if (anchor.isConnected) {
        repositoryNavigationReplay.add(anchor);
        anchor.click();
        return;
      }

      window.open(url.toString(), '_blank', 'noopener,noreferrer');
      return;
    }

    window.location.assign(url.toString());
  }

  function chooseDecisionState(cachedState, freshState) {
    if (freshState.state === 'unknown') {
      return cachedState;
    }

    return freshState;
  }

  function getCachedRepositoryState(url) {
    const normalizedUrl = normalizeUrl(url);
    const cachedState = repositoryStateCache.get(normalizedUrl) || null;
    if (!cachedState) {
      return null;
    }

    return cachedState;
  }

  function isRepositoryStateFresh(state) {
    return Date.now() - state.checkedAt < CACHE_FRESHNESS_MS;
  }

  async function ensureRepositoryStateForAnchor(anchor, options = {}) {
    if (!featureSettings.repositoryBlockingEnabled) {
      return null;
    }

    const url = getAnchorUrl(anchor);
    if (!url) {
      return null;
    }

    const normalizedUrl = normalizeUrl(url);
    const cachedState = repositoryStateCache.get(normalizedUrl) || null;

    if (cachedState && isRepositoryStateFresh(cachedState) && !options.forceFresh) {
      applyRepositoryState(anchor, cachedState);
      return cachedState;
    }

    if (cachedState && !options.forceFresh) {
      applyRepositoryState(anchor, cachedState);
      void requestRepositoryState(url, { forceFresh: false });
      return cachedState;
    }

    const state = await requestRepositoryState(url, { forceFresh: Boolean(options.forceFresh) });
    applyRepositoryState(anchor, state);
    return state;
  }

  function applyRepositoryStateToMatchingLinks(state) {
    const anchors = document.querySelectorAll('a[href]');
    anchors.forEach((anchor) => {
      const url = getAnchorUrl(anchor);
      if (!url) {
        return;
      }

      if (normalizeUrl(url) !== state.url) {
        return;
      }

      applyRepositoryState(anchor, state);
    });
  }

  function clearRepositoryVisualState() {
    document.querySelectorAll('a[data-devglobe-repository-state]').forEach((anchor) => {
      anchor.classList.remove(BLOCKED_LINK_CLASS);
      anchor.removeAttribute('aria-disabled');
      anchor.removeAttribute('data-devglobe-repository-state');
      anchor.removeAttribute('data-devglobe-repository-checked-at');
    });
  }

  function applyRepositoryState(anchor, state) {
    anchor.dataset.devglobeRepositoryState = state.state;
    anchor.dataset.devglobeRepositoryCheckedAt = String(state.checkedAt || Date.now());

    if (!featureSettings.repositoryBlockingEnabled) {
      anchor.classList.remove(BLOCKED_LINK_CLASS);
      anchor.removeAttribute('aria-disabled');
      return;
    }

    if (state.state === 'blocked') {
      anchor.classList.add(BLOCKED_LINK_CLASS);
      anchor.setAttribute('aria-disabled', 'true');
      return;
    }

    anchor.classList.remove(BLOCKED_LINK_CLASS);
    anchor.removeAttribute('aria-disabled');
  }

  async function requestRepositoryState(url, options = {}) {
    const normalizedUrl = normalizeUrl(url);
    const existingPromise = pendingRepositoryRequests.get(normalizedUrl);

    if (existingPromise && !options.forceFresh) {
      return existingPromise;
    }

    const requestPromise = sendMessage({
      type: 'devglobe:resolve-repository-state',
      url: normalizedUrl,
      forceFresh: Boolean(options.forceFresh)
    }).then((response) => {
      const state = normalizeRepositoryState(response && response.state ? response.state : response);
      if (state) {
        repositoryStateCache.set(state.url, state);
      }
      return state || createUnknownRepositoryState(normalizedUrl);
    }).catch(() => {
      const fallbackState = repositoryStateCache.get(normalizedUrl) || createUnknownRepositoryState(normalizedUrl);
      return fallbackState;
    }).finally(() => {
      pendingRepositoryRequests.delete(normalizedUrl);
    });

    pendingRepositoryRequests.set(normalizedUrl, requestPromise);
    return requestPromise;
  }

  function normalizeRepositoryState(rawState) {
    if (!rawState || typeof rawState !== 'object') {
      return null;
    }

    const normalizedUrl = normalizeUrl(rawState.url || '');
    if (!normalizedUrl) {
      return null;
    }

    const checkedAt = typeof rawState.checkedAt === 'number' ? rawState.checkedAt : Date.now();
    const status = typeof rawState.status === 'number' ? rawState.status : 0;
    const finalUrl = typeof rawState.finalUrl === 'string' && rawState.finalUrl ? rawState.finalUrl : normalizedUrl;
    const state = rawState.state === 'allowed' || rawState.state === 'blocked' || rawState.state === 'unknown'
      ? rawState.state
      : status === 404 || status === 503
        ? 'blocked'
        : status > 0
          ? 'allowed'
          : 'unknown';

    return {
      url: normalizedUrl,
      finalUrl,
      status,
      checkedAt,
      state: isAuthenticationRedirectUrl(finalUrl) ? 'blocked' : state,
      error: typeof rawState.error === 'string' && rawState.error ? rawState.error : undefined
    };
  }

  function isAuthenticationRedirectUrl(inputUrl) {
    if (typeof inputUrl !== 'string' || !inputUrl) {
      return false;
    }

    try {
      const url = new URL(inputUrl, window.location.href);
      const pathname = url.pathname.toLowerCase().replace(/\/+$/, '');

      return pathname === '/login'
        || pathname === '/users/login'
        || pathname === '/user/login'
        || pathname === '/session/new'
        || pathname === '/users/sign_in'
        || pathname.endsWith('/users/sign_in');
    } catch (error) {
      return false;
    }
  }

  function createUnknownRepositoryState(url) {
    return {
      url: normalizeUrl(url),
      finalUrl: normalizeUrl(url),
      status: 0,
      checkedAt: Date.now(),
      state: 'unknown',
      error: 'Unable to verify repository state'
    };
  }

  function getAnchorUrl(anchor) {
    const href = anchor.getAttribute('href');
    if (!href) {
      return null;
    }

    try {
      return new URL(href, window.location.href);
    } catch (error) {
      return null;
    }
  }

  function findRepositoryAnchor(target) {
    const element = target instanceof Element ? target : null;
    if (!element) {
      return null;
    }

    const anchor = element.closest('a[href]');
    if (!anchor || !isRepositoryLink(anchor)) {
      return null;
    }

    return anchor;
  }

  function isRepositoryLink(anchor) {
    const url = getAnchorUrl(anchor);
    if (!url) {
      return false;
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return false;
    }

    if (url.pathname.toLowerCase().endsWith('.git')) {
      return true;
    }

    const label = getRepositoryLabel(anchor, url);
    if (looksLikeRepositorySlug(label)) {
      return true;
    }

    const host = url.hostname.toLowerCase();
    if (!REPOSITORY_HOSTS.has(host) && !Array.from(REPOSITORY_HOSTS).some((knownHost) => host.endsWith(`.${knownHost}`))) {
      return false;
    }

    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
      return false;
    }

    const firstSegment = segments[0].toLowerCase();
    if (NON_REPOSITORY_FIRST_SEGMENTS.has(firstSegment)) {
      return false;
    }

    return true;
  }

  function looksLikeRepositorySlug(value) {
    return /^[~A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:[#?].*)?$/.test(value);
  }

  function getRepositoryLabel(anchor, url) {
    const title = (anchor.getAttribute('title') || '').trim();
    if (title) {
      return title;
    }

    const ariaLabel = (anchor.getAttribute('aria-label') || '').trim();
    if (ariaLabel) {
      return ariaLabel;
    }

    const textContent = (anchor.textContent || '').trim();
    if (textContent) {
      return textContent;
    }

    return `${url.hostname}${url.pathname}`.replace(/^https?:\/\//, '');
  }

  function normalizeUrl(inputUrl) {
    if (!inputUrl) {
      return '';
    }

    const url = new URL(inputUrl, window.location.href);
    url.hash = '';

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }

    return url.toString();
  }

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'Extension messaging failed'));
          return;
        }

        resolve(response);
      });
    });
  }

  function ensureTooltipStyles() {
    if (document.getElementById('devglobe-flag-tooltip-style')) {
      return;
    }

    const style = document.createElement('style');
    style.id = 'devglobe-flag-tooltip-style';
    style.textContent = `
      .${FLAG_CLASS} {
        cursor: help !important;
      }

      /* Default (fallback) tooltip styles */
      .${FLAG_TOOLTIP_CLASS} {
        position: fixed;
        z-index: 2147483647;
        min-width: 190px;
        max-width: 240px;
        padding: 10px 12px;
        border-radius: 12px;
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.4);
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        font-family: -apple-system, system-ui, Segoe UI, Helvetica, Arial, sans-serif;
        font-size: 12px;
        line-height: 1.35;
        pointer-events: none;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 140ms ease, transform 140ms ease;
        /* sensible defaults if no theme class present */
        background: #1a1d22;
        color: #f4f7f9;
        border: 1px solid rgba(255, 255, 255, 0.14);
      }

      /* Visible state */
      .${FLAG_TOOLTIP_CLASS}[data-visible='true'] {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }

      .${FLAG_TOOLTIP_CLASS}::before {
        content: '';
        position: absolute;
        left: var(--tooltip-arrow-x, 50%);
        top: -6px;
        width: 10px;
        height: 10px;
        border-left: 1px solid rgba(255, 255, 255, 0.14);
        border-top: 1px solid rgba(255, 255, 255, 0.14);
        background: inherit;
        transform: translateX(-50%) rotate(45deg);
      }

      .${FLAG_TOOLTIP_CLASS}[data-placement='top']::before {
        top: auto;
        bottom: -6px;
        transform: translateX(-50%) rotate(225deg);
      }

      /* Theme-aware overrides: light/dark classes on the page <html> element
        Also support our injected helper classes 'devglobe-theme-light'/'devglobe-theme-dark' */
      html.light .${FLAG_TOOLTIP_CLASS}, html.devglobe-theme-light .${FLAG_TOOLTIP_CLASS} {
        background: #FFFFFF;
        color: #191C1F;
        border: 1px solid rgba(25, 28, 31, 0.08);
      }

      html.dark .${FLAG_TOOLTIP_CLASS}, html.devglobe-theme-dark .${FLAG_TOOLTIP_CLASS} {
        background: #0F1113;
        color: #EFF1F3;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      /* Country and language colors inside the tooltip */
      .devglobe-flag-tooltip__country {
        font-size: 13px;
        font-weight: 700;
        text-align: center;
        /* fallback */
        color: #f4f7f9;
      }

      html.light .devglobe-flag-tooltip__country {
        color: #191C1F;
      }

      html.dark .devglobe-flag-tooltip__country {
        color: #EFF1F3;
      }

      .devglobe-flag-tooltip__languages {
        margin-top: 3px;
        font-size: 12px;
        text-align: center;
        color: #A3B2BD; /* requested language text color */
      }

      .${BLOCKED_LINK_CLASS} {
        cursor: not-allowed !important;
        opacity: 0.55 !important;
        pointer-events: none !important;
      }
    `;

    const root = document.head || document.documentElement;
    if (root) {
      root.appendChild(style);
    }
  }

  function ensureStatsTableStyles() {
    if (document.getElementById(STATS_TABLE_STYLE_ID)) {
      return;
    }

    const style = document.createElement('style');
    style.id = STATS_TABLE_STYLE_ID;
    style.textContent = `
      .${STATS_SORTABLE_HEADER_CLASS} {
        user-select: none;
      }

      .${STATS_SORT_BUTTON_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: flex-end;
        width: 100%;
        gap: 0.35rem;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        font-weight: inherit;
        letter-spacing: inherit;
        line-height: inherit;
        text-align: inherit;
        white-space: nowrap;
        cursor: pointer;
        appearance: none;
        -webkit-appearance: none;
      }

      .${STATS_SORT_BUTTON_CLASS}:focus-visible {
        outline: 2px solid #115bca;
        outline-offset: 3px;
        border-radius: 8px;
      }

      .devglobe-stats-sort-label {
        display: inline-flex;
        align-items: center;
      }

      .${STATS_SORT_ARROW_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 12px;
        height: 12px;
        flex: 0 0 auto;
        opacity: 0;
        transform: translateY(1px);
        transition: opacity 140ms ease, transform 140ms ease;
      }

      .${STATS_SORT_ARROW_CLASS}[data-visible='true'] {
        opacity: 1;
      }

      .${STATS_SORT_ARROW_CLASS}[data-direction='desc'] {
        transform: translateY(1px) rotate(180deg);
      }
    `;

    const root = document.head || document.documentElement;
    if (root) {
      root.appendChild(style);
    }
  }

  ensureTooltipStyles();
  ensureStatsTableStyles();
  
  // Detect page theme and add helper class if needed so tooltip styles apply
  function detectAndApplyTheme() {
    try {
      const root = document.documentElement;

      // If page already uses light/dark classes, persist and do nothing
      if (root.classList.contains('light') || root.classList.contains('dark')) {
        // remove any helper classes we previously added
        root.classList.remove('devglobe-theme-light', 'devglobe-theme-dark');
        persistDetectedTheme(root.classList.contains('light') ? 'light' : 'dark');
        return;
      }

      // If helper classes already set, keep them and persist
      if (root.classList.contains('devglobe-theme-light') || root.classList.contains('devglobe-theme-dark')) {
        persistDetectedTheme(root.classList.contains('devglobe-theme-light') ? 'light' : 'dark');
        return;
      }

      // Prefer explicit data-theme attribute if present
      const dataTheme = root.getAttribute('data-theme');
      if (dataTheme === 'light' || dataTheme === 'dark') {
        const theme = dataTheme === 'light' ? 'light' : 'dark';
        root.classList.add(theme === 'light' ? 'devglobe-theme-light' : 'devglobe-theme-dark');
        persistDetectedTheme(theme);
        return;
      }

      // Prefer prefers-color-scheme media query
      try {
        const mqDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        if (mqDark && typeof mqDark.matches === 'boolean') {
          const theme = mqDark.matches ? 'dark' : 'light';
          root.classList.add(theme === 'dark' ? 'devglobe-theme-dark' : 'devglobe-theme-light');
          // persist
          persistDetectedTheme(theme);
          // listen for changes
          mqDark.addEventListener ? mqDark.addEventListener('change', () => detectAndApplyTheme()) : mqDark.addListener(() => detectAndApplyTheme());
          return;
        }
      } catch (e) {
        // ignore
      }

      // Fallback: compute background color luminance
      try {
        const bg = window.getComputedStyle(root).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
        if (m) {
          const r = Number(m[1]) / 255;
          const g = Number(m[2]) / 255;
          const b = Number(m[3]) / 255;
          // perceptual luminance
          const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const theme = L > 0.6 ? 'light' : 'dark';
          root.classList.add(theme === 'light' ? 'devglobe-theme-light' : 'devglobe-theme-dark');
          persistDetectedTheme(theme);
          return;
        }
      } catch (e) {
        // ignore
      }

      // Default to dark
      document.documentElement.classList.add('devglobe-theme-dark');

      // persist cache
      try {
        const cached = { theme: 'dark', origin: location.origin, ts: Date.now() };
        chrome.storage && chrome.storage.local && chrome.storage.local.set({ [THEME_CACHE_KEY]: cached });
      } catch (e) {
        // ignore storage errors
      }
    } catch (e) {
      // noop
    }
  }

  // helper to persist theme when we set helper classes earlier in detection
  function persistDetectedTheme(theme) {
    try {
      const normalized = theme === 'light' ? 'light' : 'dark';
      if (lastPersistedTheme === normalized) return;
      lastPersistedTheme = normalized;
      const cached = { theme: normalized, origin: location.origin, ts: Date.now() };
      chrome.storage && chrome.storage.local && chrome.storage.local.set({ [THEME_CACHE_KEY]: cached });
    } catch (e) {
      // ignore
    }
  }

  // observe changes on <html> attributes to update theme helper classes
  try {
    const htmlObserver = new MutationObserver(() => {
      // debounce rapid mutations
      if (detectScheduled) return;
      detectScheduled = window.setTimeout(() => {
        detectScheduled = null;
        detectAndApplyTheme();
      }, 120);
    });
    htmlObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  } catch (e) {
    // ignore
  }

  // Initial detection
  detectAndApplyTheme();
})();
