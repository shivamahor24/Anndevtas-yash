import axios from "axios";

// Safe localStorage wrapper to prevent crashes in sandboxed/restricted environments
const safeLocalStorage = {
  getItem: (key) => {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn(`[AUTH-LOCALSTORAGE] getItem failed for ${key}:`, e.message);
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn(`[AUTH-LOCALSTORAGE] setItem failed for ${key}:`, e.message);
    }
  },
  removeItem: (key) => {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn(`[AUTH-LOCALSTORAGE] removeItem failed for ${key}:`, e.message);
    }
  }
};

// Helper to retrieve the current backend URL
export const getBackendUrl = () => {
  const customUrl = safeLocalStorage.getItem("pos_backend_url");
  if (customUrl) return customUrl;
  return process.env.REACT_APP_BACKEND_URL || "";
};

// Object that converts to the dynamic API string when used in template strings
export const API = {
  toString: () => `${getBackendUrl()}/api`
};

const api = axios.create({
  withCredentials: true,
});

// --- Token helpers (used by interceptors and AuthContext) ---
const TOKEN_KEY = "pos_token";
const REFRESH_KEY = "pos_refresh_token";

// Logger helper to route messages to both dev console and Electron main process logs
// Set DEBUG_AUTH=true locally to see verbose auth token flow messages.
// In production these are suppressed to prevent console flooding.
const DEBUG_AUTH = process.env.REACT_APP_DEBUG_AUTH === 'true' || false;

const log = (tag, message) => {
  // Only log if debug mode or if it's an important non-routine message
  const isVerboseRoutine = (
    tag === 'AUTH-STORE' &&
    (message === 'getAccess requested' ||
     message === 'getAccess using memory cache' ||
     message === 'getRefresh requested' ||
     message === 'getRefresh using memory cache' ||
     message.startsWith('getAccess localStorage') ||
     message.startsWith('getRefresh localStorage'))
  );
  if (!DEBUG_AUTH && isVerboseRoutine) return;

  console.log(`[${tag}]`, message);
  if (window.electronAPI && window.electronAPI.log) {
    try {
      window.electronAPI.log(tag, message);
    } catch (_) {}
  }
};

// Memory cache to keep retrieval synchronous where needed and to avoid excessive IPC overhead
let cachedAccessToken = null;
let cachedRefreshToken = null;

// Populate initial cache synchronously from localStorage
try {
  cachedAccessToken = safeLocalStorage.getItem(TOKEN_KEY);
  cachedRefreshToken = safeLocalStorage.getItem(REFRESH_KEY);
  log("AUTH-INIT", `Loaded memory cache from localStorage: access=${!!cachedAccessToken}, refresh=${!!cachedRefreshToken}`);
} catch (e) {
  log("AUTH-INIT:ERR", `Failed to initialize tokens from localStorage: ${e.message}`);
}

export const tokenStore = {
  getAccess: async () => {
    log("AUTH-STORE", "getAccess requested");
    if (cachedAccessToken) {
      log("AUTH-STORE", "getAccess using memory cache");
      return cachedAccessToken;
    }

    let electronToken = null;
    if (window.electronAPI && window.electronAPI.getAuthData) {
      try {
        electronToken = await window.electronAPI.getAuthData(TOKEN_KEY);
        log("AUTH-STORE", `getAccess electron store result: ${electronToken ? 'found' : 'not found'}`);
      } catch (e) {
        log("AUTH-STORE:ERR", `Failed to read access token from Electron: ${e.message}`);
      }
    }

    const localToken = safeLocalStorage.getItem(TOKEN_KEY);
    log("AUTH-STORE", `getAccess localStorage result: ${localToken ? 'found' : 'not found'}`);

    const token = electronToken || localToken;
    if (token) {
      cachedAccessToken = token;
      
      // Self-healing synchronization
      if (!localToken) {
        log("AUTH-STORE", "Healing: writing access token to localStorage");
        safeLocalStorage.setItem(TOKEN_KEY, token);
      }
      if (!electronToken && window.electronAPI && window.electronAPI.setAuthData) {
        log("AUTH-STORE", "Healing: writing access token to Electron store");
        try {
          await window.electronAPI.setAuthData(TOKEN_KEY, token);
        } catch (e) {
          log("AUTH-STORE:ERR", `Healing access token write failed: ${e.message}`);
        }
      }
      return token;
    }

    log("AUTH-STORE", "getAccess: no access token found anywhere");
    return null;
  },

  getRefresh: async () => {
    log("AUTH-STORE", "getRefresh requested");
    if (cachedRefreshToken) {
      log("AUTH-STORE", "getRefresh using memory cache");
      return cachedRefreshToken;
    }

    let electronToken = null;
    if (window.electronAPI && window.electronAPI.getAuthData) {
      try {
        electronToken = await window.electronAPI.getAuthData(REFRESH_KEY);
        log("AUTH-STORE", `getRefresh electron store result: ${electronToken ? 'found' : 'not found'}`);
      } catch (e) {
        log("AUTH-STORE:ERR", `Failed to read refresh token from Electron: ${e.message}`);
      }
    }

    const localToken = safeLocalStorage.getItem(REFRESH_KEY);
    log("AUTH-STORE", `getRefresh localStorage result: ${localToken ? 'found' : 'not found'}`);

    const token = electronToken || localToken;
    if (token) {
      cachedRefreshToken = token;

      // Self-healing synchronization
      if (!localToken) {
        log("AUTH-STORE", "Healing: writing refresh token to localStorage");
        safeLocalStorage.setItem(REFRESH_KEY, token);
      }
      if (!electronToken && window.electronAPI && window.electronAPI.setAuthData) {
        log("AUTH-STORE", "Healing: writing refresh token to Electron store");
        try {
          await window.electronAPI.setAuthData(REFRESH_KEY, token);
        } catch (e) {
          log("AUTH-STORE:ERR", `Healing refresh token write failed: ${e.message}`);
        }
      }
      return token;
    }

    log("AUTH-STORE", "getRefresh: no refresh token found anywhere");
    return null;
  },

  setTokens: async (access, refresh) => {
    log("AUTH-STORE", `setTokens: storing access=${!!access}, refresh=${!!refresh}`);
    if (access) {
      cachedAccessToken = access;
      safeLocalStorage.setItem(TOKEN_KEY, access);
      if (window.electronAPI && window.electronAPI.setAuthData) {
        try {
          await window.electronAPI.setAuthData(TOKEN_KEY, access);
          log("AUTH-STORE", "setTokens: access token stored in Electron");
        } catch (e) {
          log("AUTH-STORE:ERR", `Failed to save access token in Electron: ${e.message}`);
        }
      }
    }
    if (refresh) {
      cachedRefreshToken = refresh;
      safeLocalStorage.setItem(REFRESH_KEY, refresh);
      if (window.electronAPI && window.electronAPI.setAuthData) {
        try {
          await window.electronAPI.setAuthData(REFRESH_KEY, refresh);
          log("AUTH-STORE", "setTokens: refresh token stored in Electron");
        } catch (e) {
          log("AUTH-STORE:ERR", `Failed to save refresh token in Electron: ${e.message}`);
        }
      }
    }
  },

  clear: async () => {
    log("AUTH-STORE", "clear: wiping all tokens from memory and disk");
    cachedAccessToken = null;
    cachedRefreshToken = null;
    safeLocalStorage.removeItem(TOKEN_KEY);
    safeLocalStorage.removeItem(REFRESH_KEY);
    if (window.electronAPI && window.electronAPI.clearAuthData) {
      try {
        await window.electronAPI.clearAuthData();
        log("AUTH-STORE", "clear: Electron auth data cleared");
      } catch (e) {
        log("AUTH-STORE:ERR", `Failed to clear Electron auth data: ${e.message}`);
      }
    }
  },
};

// Flag to prevent infinite refresh loops
let isRefreshing = false;
let refreshSubscribers = [];

function onRefreshed(newToken) {
  refreshSubscribers.forEach((cb) => cb(newToken));
  refreshSubscribers = [];
}

function addRefreshSubscriber(cb) {
  refreshSubscribers.push(cb);
}

// Request interceptor — attach token to every request
api.interceptors.request.use(async (cfg) => {
  cfg.baseURL = `${getBackendUrl()}/api`;
  const t = await tokenStore.getAccess();
  if (t) cfg.headers.Authorization = `Bearer ${t}`;
  return cfg;
});

// Response interceptor — auto-refresh on 401 "Token expired"
api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const originalRequest = error.config;
    const status = error.response?.status;
    const detail = error.response?.data?.detail;

    // Only attempt refresh for expired tokens, not for login failures or other 401s
    const isExpired = status === 401 && (detail === "Token expired" || detail === "Not authenticated");
    const isRefreshUrl = originalRequest?.url?.includes("/auth/refresh");
    const isLoginUrl = originalRequest?.url?.includes("/auth/login");

    if (isExpired && !originalRequest._retry && !isRefreshUrl && !isLoginUrl) {
      originalRequest._retry = true;
      const refreshToken = await tokenStore.getRefresh();

      if (!refreshToken) {
        log("AUTH-INTERCEPTOR", "No refresh token available — aborting silent refresh");
        return Promise.reject(error);
      }

      if (isRefreshing) {
        log("AUTH-INTERCEPTOR", "Refresh already in-flight — queueing request");
        return new Promise((resolve) => {
          addRefreshSubscriber((newToken) => {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            resolve(api(originalRequest));
          });
        });
      }

      isRefreshing = true;
      log("AUTH-INTERCEPTOR", "Access token expired — starting silent refresh…");

      try {
        const { data } = await axios.post(
          `${getBackendUrl()}/api/auth/refresh`,
          { refresh_token: refreshToken },
          { withCredentials: true }
        );

        await tokenStore.setTokens(data.token, data.refresh_token);
        log("AUTH-INTERCEPTOR", "Silent refresh successful — retrying request");

        // Notify queued requests
        onRefreshed(data.token);

        // Retry the original request with the new token
        originalRequest.headers.Authorization = `Bearer ${data.token}`;
        return api(originalRequest);
      } catch (refreshError) {
        log("AUTH-INTERCEPTOR:ERR", `Silent refresh failed: ${refreshError?.response?.data?.detail || refreshError.message}`);
        // Clear tokens — user must re-login
        await tokenStore.clear();
        refreshSubscribers = [];
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
