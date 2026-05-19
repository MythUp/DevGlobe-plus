'use strict';

const SETTINGS_KEY = 'devglobe.featureSettings.v1';
const DEFAULT_SETTINGS = {
  flagTooltipsEnabled: true,
  repositoryBlockingEnabled: true
};

const manifest = chrome.runtime.getManifest();

const elements = {
  title: document.getElementById('popupTitle'),
  version: document.getElementById('popupVersion'),
  authorLink: document.getElementById('popupAuthorLink'),
  flagTooltipToggle: document.getElementById('flagTooltipToggle'),
  repositoryBlockingToggle: document.getElementById('repositoryBlockingToggle')
};

initializePopup();

async function initializePopup() {
  renderManifestDetails();
  bindActions();
  const settings = await loadSettings();
  await ensureDefaultSettings(settings);
  renderSettings(settings);

  chrome.storage.onChanged.addListener(handleStorageChange);
}

function renderManifestDetails() {
  const title = manifest.action && typeof manifest.action.default_title === 'string'
    ? manifest.action.default_title
    : manifest.name;
  const version = typeof manifest.version === 'string' ? manifest.version : '1.0.0';
  const author = typeof manifest.author === 'string' ? manifest.author : 'MythUp';

  document.title = title;
  elements.title.textContent = title;
  elements.version.textContent = `Version ${version}`;
  elements.authorLink.textContent = author;
  elements.authorLink.href = `https://github.com/${encodeURIComponent(author)}`;
}

function bindActions() {
  elements.flagTooltipToggle.addEventListener('change', () => {
    void updateSetting('flagTooltipsEnabled', elements.flagTooltipToggle.checked);
  });

  elements.repositoryBlockingToggle.addEventListener('change', () => {
    void updateSetting('repositoryBlockingEnabled', elements.repositoryBlockingToggle.checked);
  });
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const rawSettings = stored[SETTINGS_KEY];
  
  // If no settings exist yet, save defaults
  if (!rawSettings) {
    await chrome.storage.local.set({
      [SETTINGS_KEY]: DEFAULT_SETTINGS
    });
    return DEFAULT_SETTINGS;
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
      : DEFAULT_SETTINGS.repositoryBlockingEnabled
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
}

async function updateSetting(settingName, value) {
  const currentSettings = await loadSettings();
  const nextSettings = {
    ...currentSettings,
    [settingName]: Boolean(value)
  };

  await chrome.storage.local.set({
    [SETTINGS_KEY]: nextSettings
  });
}

function handleStorageChange(changes, areaName) {
  if (areaName !== 'local' || !changes[SETTINGS_KEY]) {
    return;
  }

  renderSettings(normalizeSettings(changes[SETTINGS_KEY].newValue));
}
