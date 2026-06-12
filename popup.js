'use strict';

const SETTINGS_KEY = 'devglobe.featureSettings.v1';
const DEFAULT_SETTINGS = {
  flagTooltipsEnabled: true,
  repositoryBlockingEnabled: true,
  statsTableSortingEnabled: true,
  searchKeyboardShortcutEnabled: true,
  dropdownNavigationEnabled: true,
  escapeKeyClosesModals: true,
  replaceCommandKeyEnabled: false
};

const THEME_CACHE_KEY = 'devglobe.cachedTheme.v1';
const manifest = chrome.runtime.getManifest();

const elements = {
  title: document.getElementById('popupTitle'),
  version: document.getElementById('popupVersion'),
  authorLink: document.getElementById('popupAuthorLink'),
  flagTooltipToggle: document.getElementById('flagTooltipToggle'),
  repositoryBlockingToggle: document.getElementById('repositoryBlockingToggle'),
  statsTableSortingToggle: document.getElementById('statsTableSortingToggle'),
  searchKeyboardShortcutToggle: document.getElementById('searchKeyboardShortcutToggle'),
  dropdownNavigationToggle: document.getElementById('dropdownNavigationToggle'),
  escapeKeyClosesModalsToggle: document.getElementById('escapeKeyClosesModalsToggle'),
  replaceCommandKeyToggle: document.getElementById('replaceCommandKeyToggle'),
  replaceCommandKeyRow: document.getElementById('replaceCommandKeyRow')
};

// Detect if the OS is Windows or Linux
function isWindowsOrLinux() {
  const platform = window.navigator.platform;
  return /Win|Linux|X11/.test(platform);
}

initializePopup();

async function initializePopup() {
  renderManifestDetails();
  bindActions();
  await applyCachedTheme();
  const settings = await loadSettings();
  await ensureDefaultSettings(settings);
  renderSettings(settings);
  
  // Hide or show the setting based on the OS
  const isWinOrLinux = isWindowsOrLinux();
  if (elements.replaceCommandKeyRow) {
    elements.replaceCommandKeyRow.style.display = isWinOrLinux ? '' : 'none';
  }
  
  chrome.storage.onChanged.addListener(handleStorageChange);
}

async function applyCachedTheme() {
  try {
    const stored = await chrome.storage.local.get(THEME_CACHE_KEY);
    const cached = stored[THEME_CACHE_KEY];
    if (cached && (cached.theme === 'light' || cached.theme === 'dark')) {
      const root = document.documentElement;
      root.classList.remove('light', 'dark');
      root.classList.add(cached.theme);
    }
  } catch (e) {
    // ignore
  }
}

function renderManifestDetails() {
  const manifestDetails = getManifestDetails();
  document.title = manifestDetails.title;
  elements.title.textContent = manifestDetails.title;
  elements.version.textContent = `Version ${manifestDetails.version}`;
  elements.authorLink.textContent = manifestDetails.authorName;
  if (manifestDetails.authorUrl) {
    elements.authorLink.href = manifestDetails.authorUrl;
    elements.authorLink.target = '_blank';
    elements.authorLink.rel = 'noopener noreferrer';
  } else {
    elements.authorLink.removeAttribute('href');
    elements.authorLink.removeAttribute('target');
    elements.authorLink.removeAttribute('rel');
  }
}

function getManifestDetails() {
  const title = typeof manifest.action?.default_title === 'string' && manifest.action.default_title.trim()
    ? manifest.action.default_title.trim()
    : typeof manifest.name === 'string' && manifest.name.trim()
      ? manifest.name.trim()
      : 'DevGlobe+';
  const version = typeof manifest.version === 'string' && manifest.version.trim()
    ? manifest.version.trim()
    : 'unknown';
  const author = getManifestAuthor(manifest);
  return { title, version, authorName: author.name, authorUrl: author.url };
}

function getManifestAuthor(manifestData) {
  const rawAuthor = manifestData.author;
  if (typeof rawAuthor === 'string' && rawAuthor.trim()) {
    const authorName = rawAuthor.trim();
    return { name: authorName, url: `https://github.com/${encodeURIComponent(authorName)}` };
  }
  if (rawAuthor && typeof rawAuthor === 'object') {
    const authorName = typeof rawAuthor.name === 'string' && rawAuthor.name.trim()
      ? rawAuthor.name.trim()
      : 'Unknown author';
    const authorUrl = typeof rawAuthor.url === 'string' && rawAuthor.url.trim()
      ? rawAuthor.url.trim()
      : '';
    return { name: authorName, url: authorUrl };
  }
  return { name: 'Unknown author', url: '' };
}

function bindActions() {
  elements.flagTooltipToggle.addEventListener('change', () => {
    void updateSetting('flagTooltipsEnabled', elements.flagTooltipToggle.checked);
  });
  elements.repositoryBlockingToggle.addEventListener('change', () => {
    void updateSetting('repositoryBlockingEnabled', elements.repositoryBlockingToggle.checked);
  });
  elements.statsTableSortingToggle.addEventListener('change', () => {
    void updateSetting('statsTableSortingEnabled', elements.statsTableSortingToggle.checked);
  });
  elements.searchKeyboardShortcutToggle.addEventListener('change', () => {
    void updateSetting('searchKeyboardShortcutEnabled', elements.searchKeyboardShortcutToggle.checked);
  });
  elements.dropdownNavigationToggle.addEventListener('change', () => {
    void updateSetting('dropdownNavigationEnabled', elements.dropdownNavigationToggle.checked);
  });
  elements.escapeKeyClosesModalsToggle.addEventListener('change', () => {
    void updateSetting('escapeKeyClosesModals', elements.escapeKeyClosesModalsToggle.checked);
  });
  if (elements.replaceCommandKeyToggle) {
    elements.replaceCommandKeyToggle.addEventListener('change', () => {
      void updateSetting('replaceCommandKeyEnabled', elements.replaceCommandKeyToggle.checked);
    });
  }
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const rawSettings = stored[SETTINGS_KEY];
  // If no settings exist yet, save defaults
  if (!rawSettings) {
    const defaultSettings = { ...DEFAULT_SETTINGS };
    // Enable by default on Windows/Linux
    if (isWindowsOrLinux()) {
      defaultSettings.replaceCommandKeyEnabled = true;
    }
    await chrome.storage.local.set({ [SETTINGS_KEY]: defaultSettings });
    return defaultSettings;
  }
  return normalizeSettings(rawSettings);
}

function normalizeSettings(rawSettings) {
  return {
    flagTooltipsEnabled: typeof rawSettings?.flagTooltipsEnabled === 'boolean'
      ? rawSettings.flagTooltipsEnabled
      : DEFAULT_SETTINGS.flagTooltipsEnabled,
    repositoryBlockingEnabled: typeof rawSettings?.repositoryBlockingEnabled === 'boolean'
      ? rawSettings.repositoryBlockingEnabled
      : DEFAULT_SETTINGS.repositoryBlockingEnabled,
    statsTableSortingEnabled: typeof rawSettings?.statsTableSortingEnabled === 'boolean'
      ? rawSettings.statsTableSortingEnabled
      : DEFAULT_SETTINGS.statsTableSortingEnabled,
    searchKeyboardShortcutEnabled: typeof rawSettings?.searchKeyboardShortcutEnabled === 'boolean'
      ? rawSettings.searchKeyboardShortcutEnabled
      : DEFAULT_SETTINGS.searchKeyboardShortcutEnabled,
    dropdownNavigationEnabled: typeof rawSettings?.dropdownNavigationEnabled === 'boolean'
      ? rawSettings.dropdownNavigationEnabled
      : DEFAULT_SETTINGS.dropdownNavigationEnabled,
    escapeKeyClosesModals: typeof rawSettings?.escapeKeyClosesModals === 'boolean'
      ? rawSettings.escapeKeyClosesModals
      : DEFAULT_SETTINGS.escapeKeyClosesModals,
    replaceCommandKeyEnabled: typeof rawSettings?.replaceCommandKeyEnabled === 'boolean'
      ? rawSettings.replaceCommandKeyEnabled
      : DEFAULT_SETTINGS.replaceCommandKeyEnabled
  };
}

async function ensureDefaultSettings(settings) {
  // Already handled in loadSettings
  return;
}

function renderSettings(settings) {
  const normalizedSettings = normalizeSettings(settings);
  elements.flagTooltipToggle.checked = normalizedSettings.flagTooltipsEnabled;
  elements.repositoryBlockingToggle.checked = normalizedSettings.repositoryBlockingEnabled;
  elements.statsTableSortingToggle.checked = normalizedSettings.statsTableSortingEnabled;
  elements.searchKeyboardShortcutToggle.checked = normalizedSettings.searchKeyboardShortcutEnabled;
  elements.dropdownNavigationToggle.checked = normalizedSettings.dropdownNavigationEnabled;
  elements.escapeKeyClosesModalsToggle.checked = normalizedSettings.escapeKeyClosesModals;
  if (elements.replaceCommandKeyToggle) {
    elements.replaceCommandKeyToggle.checked = normalizedSettings.replaceCommandKeyEnabled;
  }
}

async function updateSetting(key, value) {
  const settings = await loadSettings();
  settings[key] = value;
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });

  // Envoyer un message au script de contenu si le réglage de la touche de commande change
  if (key === 'replaceCommandKeyEnabled') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'updateCommandKeySetting', enabled: value });
      }
    });
  }
}

function handleStorageChange(changes, areaName) {
  if (areaName !== 'local') {
    return;
  }
  if (changes[SETTINGS_KEY]) {
    renderSettings(normalizeSettings(changes[SETTINGS_KEY].newValue));
  }
  if (changes[THEME_CACHE_KEY]) {
    const newVal = changes[THEME_CACHE_KEY].newValue;
    if (newVal && (newVal.theme === 'light' || newVal.theme === 'dark')) {
      const root = document.documentElement;
      root.classList.remove('light', 'dark');
      root.classList.add(newVal.theme);
    }
  }
}
