/**
 * Client HTTP du backend NeuroBeats (FastAPI).
 *
 * Le backend activant CORS, le front peut l'appeler directement depuis le browser.
 * Phase 0 : couche minimale (fetch + gestion d'erreur + enveloppe {status, data, error}).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

/** Erreur applicative remontée par l'API ou le réseau. */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Réponse normalisée du backend. */
export interface ApiResponse<T = unknown> {
  status: "ok" | "error";
  data?: T;
  error?: string | null;
}

/**
 * Wrapper fetch vers le backend.
 *
 * @param path Chemin de l'endpoint (ex. "/api/search").
 * @param init Options fetch (method, body JSON, signal...).
 * @returns Le champ `data` typé, ou lève une ApiError.
 */
export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(`Backend injoignable (${API_URL})`, 0);
  }

  let body: ApiResponse<T> | null = null;
  try {
    body = (await response.json()) as ApiResponse<T>;
  } catch {
    body = null;
  }

  if (!response.ok || body?.status === "error") {
    throw new ApiError(
      body?.error ?? `Erreur ${response.status}`,
      response.status,
    );
  }

  return body?.data as T;
}

export const api = {
  health: () => apiFetch("/api/health"),
  search: (q: string, limit = 5) =>
    apiFetch(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  stats: () => apiFetch("/api/stats"),
  recommend: (mood = "", forceGenre = false) =>
    apiFetch(
      `/api/recommend?mood=${encodeURIComponent(mood)}&force_genre=${forceGenre}`,
    ),
};
