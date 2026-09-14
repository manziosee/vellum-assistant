/**
 * Token acquisition for Google service-account credentials (Vertex AI).
 *
 * Reads the service-account JSON from the vault, signs a short-lived JWT
 * with RS256, and exchanges it for a bearer access token at the token_uri
 * embedded in the key file. Caches the resulting token in the vault so
 * repeated inference calls within the token's lifetime skip the exchange.
 *
 * A module-level mutex prevents concurrent callers from racing to refresh:
 * only the first waiter performs the exchange; the rest coalesce onto its
 * result.
 */

import { createSign } from "node:crypto";

import {
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";

const log = getLogger("service-account-token");

/** Refresh 5 minutes before expiry to avoid using a nearly-expired token. */
const REFRESH_MARGIN_SECONDS = 300;

/** Google Cloud Platform scope required for Vertex AI inference. */
const GCP_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Module-level mutex: only one in-flight exchange at a time per process. */
let exchangeInFlight: Promise<string | null> | null = null;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

/**
 * Return a valid bearer access token for a Google service account, fetching
 * and caching one if the stored token is absent or about to expire.
 *
 * @param credential - Vault key under which the service-account JSON is stored
 *   (e.g. `"credential/my-vertex-ai"`). Derived tokens are cached at
 *   `<credential>/access_token` and `<credential>/expires_at`.
 * @returns Bearer token string, or `null` if no service-account JSON is stored
 *   at the given key.
 */
export async function getValidServiceAccountToken(
  credential: string,
): Promise<string | null> {
  const cachedToken = await getSecureKeyAsync(`${credential}/access_token`);
  if (cachedToken) {
    const expiresAtStr = await getSecureKeyAsync(`${credential}/expires_at`);
    if (expiresAtStr) {
      const expiresAt = Number(expiresAtStr);
      const now = Date.now() / 1000;
      if (now < expiresAt - REFRESH_MARGIN_SECONDS) {
        return cachedToken;
      }
    } else {
      return cachedToken;
    }
  }

  if (exchangeInFlight) {
    return await exchangeInFlight;
  }

  exchangeInFlight = doExchange(credential);
  try {
    return await exchangeInFlight;
  } finally {
    exchangeInFlight = null;
  }
}

async function doExchange(credential: string): Promise<string | null> {
  const keyJson = await getSecureKeyAsync(credential);
  if (!keyJson) {
    return null;
  }

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(keyJson) as ServiceAccountKey;
  } catch {
    log.error({ credential }, "Service account credential is not valid JSON");
    return null;
  }

  if (!key.client_email || !key.private_key || !key.token_uri) {
    log.error(
      { credential },
      "Service account JSON missing required fields (client_email, private_key, token_uri)",
    );
    return null;
  }

  const jwt = buildJwt(key.client_email, key.private_key, key.token_uri);

  let accessToken: string;
  let expiresIn: number;
  try {
    const resp = await fetch(key.token_uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }).toString(),
    });

    if (!resp.ok) {
      const body = await resp.text();
      log.error(
        { status: resp.status, body, credential },
        "Service account token exchange failed",
      );
      return (await getSecureKeyAsync(`${credential}/access_token`)) ?? null;
    }

    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      log.error({ credential }, "Token exchange response missing access_token");
      return (await getSecureKeyAsync(`${credential}/access_token`)) ?? null;
    }

    accessToken = data.access_token;
    expiresIn = data.expires_in ?? 3600;
  } catch (err) {
    log.error({ err, credential }, "Service account token exchange threw");
    return (await getSecureKeyAsync(`${credential}/access_token`)) ?? null;
  }

  await setSecureKeyAsync(`${credential}/access_token`, accessToken);
  const newExpiresAt = Math.floor(Date.now() / 1000 + expiresIn);
  await setSecureKeyAsync(`${credential}/expires_at`, String(newExpiresAt));

  log.info({ credential }, "Service account token exchanged and cached");
  return accessToken;
}

function buildJwt(
  clientEmail: string,
  privateKey: string,
  tokenUri: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: GCP_SCOPE,
      aud: tokenUri,
      exp: now + 3600,
      iat: now,
    }),
  ).toString("base64url");

  const signingInput = `${header}.${payload}`;
  const sign = createSign("SHA256");
  sign.update(signingInput);
  sign.end();
  const signature = sign.sign(privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** @internal Test-only: reset the in-flight exchange mutex. */
export function _resetServiceAccountMutex(): void {
  exchangeInFlight = null;
}
