
const isNode = typeof window === 'undefined';

const isClearAccessTokenRequested = () =>
    !isNode && new URLSearchParams(window.location.search).get("clear_access_token") === 'true';

const clearStoredAccessToken = () => {
    window.localStorage.removeItem('base44_access_token');
    window.localStorage.removeItem('token');
}

const getAppParams = () => {
    if (isClearAccessTokenRequested()) {
        clearStoredAccessToken();
    }
    return {
        appId: import.meta.env.VITE_BASE44_APP_ID,
        token: getAccessToken(),
        functionsVersion: (!isNode && new URLSearchParams(window.location.search).get("functions_version")?.trim()) || import.meta.env.VITE_BASE44_FUNCTIONS_VERSION,
        appBaseUrl: import.meta.env.VITE_BASE44_APP_BASE_URL,
    }
}

// The access token arrives once in the URL (?access_token=) after login; it is
// moved to localStorage and stripped from the address bar.
function getAccessToken() {
    if (isNode) return null;
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('access_token');
    if (fromUrl) {
        window.localStorage.setItem('base44_access_token', fromUrl);
        url.searchParams.delete('access_token');
        window.history.replaceState({}, document.title, url.toString());
        return fromUrl;
    }
    return window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');
}

export const appParams = {
    ...getAppParams(),
};
