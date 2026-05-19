'use strict';

const STORAGE_KEY = 'devglobe.repositoryStateCache.v1';
const CACHE_TTL_MS = 2 * 60 * 1000;
const BLOCKED_STATUSES = new Set([404, 503]);

const repositoryStateCache = new Map();
const pendingRefreshes = new Map();
let cacheLoadPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  void ensureCacheLoaded();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureCacheLoaded();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') {
    return false;
  }

  switch (message.type) {
    case 'devglobe:get-cache-snapshot':
      void ensureCacheLoaded().then(() => {
        sendResponse({
          entries: getSnapshotEntries(),
          summary: buildSummary()
        });
      });
      return true;

    case 'devglobe:get-cache-summary':
      void ensureCacheLoaded().then(() => {
        sendResponse(buildSummary());
      });
      return true;

    case 'devglobe:resolve-repository-state':
      void ensureCacheLoaded().then(async () => {
        const url = normalizeUrl(message.url);
        const state = await resolveRepositoryState(url, {
          forceFresh: Boolean(message.forceFresh)
        });

        sendResponse({
          state: cloneState(state),
          summary: buildSummary()
        });
      }).catch((error) => {
        sendResponse({
          state: createUnknownState(String(message.url || ''), error),
          summary: buildSummary(),
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return true;

    case 'devglobe:refresh-cache':
      void ensureCacheLoaded().then(async () => {
        const results = await refreshAllCachedStates();
        sendResponse({
          states: results.map(cloneState),
          summary: buildSummary()
        });
      });
      return true;

    case 'devglobe:clear-cache':
      void ensureCacheLoaded().then(async () => {
        repositoryStateCache.clear();
        await persistCache();
        broadcastCacheCleared();
        sendResponse({
          ok: true,
          summary: buildSummary()
        });
      }).catch((error) => {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        });
      });
      return true;

    default:
      return false;
  }
});

async function ensureCacheLoaded() {
  if (cacheLoadPromise) {
    return cacheLoadPromise;
  }

  cacheLoadPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      const rawEntries = stored[STORAGE_KEY];

      repositoryStateCache.clear();

      if (rawEntries && typeof rawEntries === 'object') {
        for (const [url, rawState] of Object.entries(rawEntries)) {
          const normalizedState = normalizeCachedState(url, rawState);
          if (normalizedState) {
            repositoryStateCache.set(url, normalizedState);
          }
        }
      }
    } catch (error) {
      repositoryStateCache.clear();
      throw error;
    }
  })();

  return cacheLoadPromise;
}

async function persistCache() {
  const serializedEntries = {};

  for (const [url, state] of repositoryStateCache.entries()) {
    serializedEntries[url] = cloneState(state);
  }

  await chrome.storage.local.set({
    [STORAGE_KEY]: serializedEntries
  });
}

function buildSummary() {
  let blocked = 0;
  let allowed = 0;
  let unknown = 0;
  let stale = 0;
  let fresh = 0;
  let latestCheckedAt = 0;

  for (const state of repositoryStateCache.values()) {
    if (state.state === 'blocked') {
      blocked += 1;
    } else if (state.state === 'allowed') {
      allowed += 1;
    } else {
      unknown += 1;
    }

    if (isFreshState(state)) {
      fresh += 1;
    } else {
      stale += 1;
    }

    latestCheckedAt = Math.max(latestCheckedAt, state.checkedAt || 0);
  }

  return {
    total: repositoryStateCache.size,
    blocked,
    allowed,
    unknown,
    fresh,
    stale,
    latestCheckedAt
  };
}

function getSnapshotEntries() {
  return Array.from(repositoryStateCache.values())
    .map((state) => cloneState(state))
    .sort((left, right) => right.checkedAt - left.checkedAt);
}

function normalizeCachedState(url, rawState) {
  if (!rawState || typeof rawState !== 'object') {
    return null;
  }

  const normalizedUrl = normalizeUrl(rawState.url || url);
  const status = typeof rawState.status === 'number' ? rawState.status : 0;
  const checkedAt = typeof rawState.checkedAt === 'number' ? rawState.checkedAt : Date.now();
  const finalUrl = typeof rawState.finalUrl === 'string' && rawState.finalUrl ? rawState.finalUrl : normalizedUrl;
  const state = normalizeStateLabel(rawState.state, status, rawState.error);

  return {
    url: normalizedUrl,
    finalUrl,
    status,
    checkedAt,
    state: isAuthenticationRedirectUrl(finalUrl) ? 'blocked' : state,
    error: typeof rawState.error === 'string' ? rawState.error : undefined
  };
}

function normalizeStateLabel(state, status, error) {
  if (state === 'allowed' || state === 'blocked' || state === 'unknown') {
    return state;
  }

  if (BLOCKED_STATUSES.has(status)) {
    return 'blocked';
  }

  if (status > 0) {
    return 'allowed';
  }

  if (error) {
    return 'unknown';
  }

  return 'unknown';
}

function cloneState(state) {
  return {
    url: state.url,
    finalUrl: state.finalUrl,
    status: state.status,
    checkedAt: state.checkedAt,
    state: state.state,
    error: state.error
  };
}

function createUnknownState(url, error) {
  return {
    url: normalizeUrl(url),
    finalUrl: normalizeUrl(url),
    status: 0,
    checkedAt: Date.now(),
    state: 'unknown',
    error: error instanceof Error ? error.message : String(error)
  };
}

function isFreshState(state) {
  return Date.now() - state.checkedAt < CACHE_TTL_MS;
}

function isAuthenticationRedirectUrl(inputUrl) {
  if (typeof inputUrl !== 'string' || !inputUrl) {
    return false;
  }

  try {
    const url = new URL(inputUrl, 'https://devglobe.app');
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

async function resolveRepositoryState(url, options = {}) {
  const normalizedUrl = normalizeUrl(url);
  const forceFresh = Boolean(options.forceFresh);
  const cachedState = repositoryStateCache.get(normalizedUrl) || null;

  if (cachedState && isFreshState(cachedState) && !forceFresh) {
    return cachedState;
  }

  if (cachedState && !forceFresh) {
    void queueRepositoryRefresh(normalizedUrl).catch(() => undefined);
    return cachedState;
  }

  return queueRepositoryRefresh(normalizedUrl);
}

async function refreshAllCachedStates() {
  const refreshPromises = [];

  for (const url of repositoryStateCache.keys()) {
    refreshPromises.push(queueRepositoryRefresh(url));
  }

  return Promise.all(refreshPromises);
}

async function queueRepositoryRefresh(url) {
  const normalizedUrl = normalizeUrl(url);
  const existingRefresh = pendingRefreshes.get(normalizedUrl);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refreshPromise = (async () => {
    const previousState = repositoryStateCache.get(normalizedUrl) || null;
    const refreshedState = await fetchRepositoryState(normalizedUrl);

    if (refreshedState.state === 'unknown' && previousState) {
      return previousState;
    }

    repositoryStateCache.set(normalizedUrl, refreshedState);
    await persistCache();

    if (!previousState || hasStateChanged(previousState, refreshedState)) {
      broadcastStateUpdate(refreshedState, previousState);
    }

    return refreshedState;
  })().finally(() => {
    pendingRefreshes.delete(normalizedUrl);
  });

  pendingRefreshes.set(normalizedUrl, refreshPromise);
  return refreshPromise;
}

async function fetchRepositoryState(url) {
  try {
    let response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      cache: 'no-store',
      credentials: 'omit'
    });

    if (response.status === 405 || response.status === 501) {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'omit'
      });
    }

    return {
      url,
      finalUrl: response.url || url,
      status: response.status,
      checkedAt: Date.now(),
      state: isAuthenticationRedirectUrl(response.url || url)
        ? 'blocked'
        : BLOCKED_STATUSES.has(response.status)
        ? 'blocked'
        : response.status > 0
          ? 'allowed'
          : 'unknown'
    };
  } catch (error) {
    return createUnknownState(url, error);
  }
}

function hasStateChanged(previousState, nextState) {
  return previousState.state !== nextState.state
    || previousState.status !== nextState.status
    || previousState.finalUrl !== nextState.finalUrl;
}

function broadcastStateUpdate(state, previousState) {
  chrome.runtime.sendMessage({
    type: 'devglobe:repository-state-updated',
    state: cloneState(state),
    previousState: previousState ? cloneState(previousState) : null
  });
}

function broadcastCacheCleared() {
  chrome.runtime.sendMessage({
    type: 'devglobe:cache-cleared'
  });
}

function normalizeUrl(inputUrl) {
  const url = new URL(inputUrl, 'https://devglobe.app');
  url.hash = '';

  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  return url.toString();
}
