// Thin REST client for the backend. `api()` is the generic wrapper; the
// named helpers below are the only endpoints the frontend uses.

/** Perform a JSON fetch, throwing Error(message) on a non-2xx response. */
export async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body) {
    opt.headers["Content-Type"] = "application/json";
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error((data && data.error) || ("HTTP " + res.status));
  return data;
}

export const getSessions = () => api("GET", "/api/sessions");
export const getOffline = () => api("GET", "/api/sessions/offline");
export const getTerminal = (name) => api("GET", "/api/sessions/" + encodeURIComponent(name) + "/terminal");
export const killSession = (name) => api("DELETE", "/api/sessions/" + encodeURIComponent(name));
export const createSession = (name, parent, folder) => api("POST", "/api/sessions", { name, parent, folder });
export const wakeSession = (name, cwd) => api("POST", "/api/sessions/" + encodeURIComponent(name) + "/wake", { cwd });

const qs = (o) => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

export const getFolders = (parent) => api("GET", "/api/folders?" + qs({ parent }));
export const createFolder = (parent, name) => api("POST", "/api/folders", { parent, name });
export const getSuggestedName = (parent, folder) => api("GET", "/api/folders/suggested-name?" + qs({ parent, folder }));

// parents + directory browser (settings)
export const getParents = () => api("GET", "/api/parents");
export const addParent = (path) => api("POST", "/api/parents", { path });
export const removeParent = (path) => api("DELETE", "/api/parents", { path });
export const reorderParents = (order) => api("PUT", "/api/parents/order", { order });
export const browseDir = (path) => api("GET", "/api/browse" + (path ? "?" + qs({ path }) : ""));
