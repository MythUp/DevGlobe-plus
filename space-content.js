'use strict';

(function () {
  // Constants
  const FLAG_CLASS = 'devglobe-flag';
  const FLAG_TOOLTIP_CLASS = 'devglobe-flag-tooltip';
  const BLOCKED_LINK_CLASS = 'devglobe-repo-link--blocked';
  const FEATURE_SETTINGS_KEY = 'devglobe.featureSettings.v1';
  const SCAN_INTERVAL_MS = 1500;
  const CACHE_FRESHNESS_MS = 2 * 60 * 1000;
  
  // Default settings
  const DEFAULT_FEATURE_SETTINGS = {
    flagTooltipsEnabled: true,
    repositoryBlockingEnabled: true
  };

  // Global state
  let featureSettings = { ...DEFAULT_FEATURE_SETTINGS };
  let tooltipElement = null;
  let tooltipVisible = false;
  let activeTooltipAnchor = null;
  let tooltipHideTimer = null;
  let countryDisplayNames = null;
  let languageDisplayNames = null;
  let repositoryStateCache = new Map();
  let pendingRepositoryRequests = new Map();
  const repositoryNavigationReplay = new WeakSet();
  let mutationObserver = null;
  let scanIntervalId = null;
  let scanQueued = false;
  let cacheReadyPromise = null;

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
    activeTooltipAnchor = null;

    if (!tooltipElement) {
      return;
    }

    tooltipElement.dataset.visible = 'false';
    tooltipElement.setAttribute('aria-hidden', 'true');
    tooltipElement.removeAttribute('data-placement');
    tooltipElement.style.visibility = 'hidden';
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
        : DEFAULT_FEATURE_SETTINGS.repositoryBlockingEnabled
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
    window.addEventListener('scroll', hideFlagTooltip, true);
    window.addEventListener('blur', hideFlagTooltip, true);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hideFlagTooltip();
      }
    });
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

      .${FLAG_TOOLTIP_CLASS} {
        position: fixed;
        z-index: 2147483647;
        min-width: 190px;
        max-width: 240px;
        padding: 10px 12px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 12px;
        background: #1a1d22;
        color: #f4f7f9;
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
      }

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

      .devglobe-flag-tooltip__country {
        font-size: 13px;
        font-weight: 700;
        color: #f4f7f9;
        text-align: center;
      }

      .devglobe-flag-tooltip__languages {
        margin-top: 3px;
        font-size: 12px;
        color: rgba(244, 247, 249, 0.72);
        text-align: center;
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

  ensureTooltipStyles();
})();
