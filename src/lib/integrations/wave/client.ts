import "server-only";

const WAVE_AUTHORIZE_URL = "https://api.waveapps.com/oauth2/authorize/";
const WAVE_TOKEN_URL = "https://api.waveapps.com/oauth2/token/";
const WAVE_GRAPHQL_URL = "https://gql.waveapps.com/graphql/public";

export const WAVE_READ_SCOPES = ["user:read", "business:read", "account:read"] as const;
export const WAVE_REQUESTED_SCOPES = [...WAVE_READ_SCOPES, "transaction:write"] as const;

export type WaveTokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type: string;
};

export type WaveBusiness = {
  id: string;
  name: string;
  isPersonal: boolean | null;
  currency: { code: string } | null;
  isClassicAccounting: boolean | null;
};

export type WaveAccount = {
  id: string;
  name: string;
  type: { name: string; value: string } | null;
  subtype: { name: string; value: string } | null;
  normalBalanceType: string | null;
  isArchived: boolean;
};

function oauthConfig() {
  const clientId = process.env.WAVE_CLIENT_ID;
  const clientSecret = process.env.WAVE_CLIENT_SECRET;
  const redirectUri = process.env.WAVE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("WAVE_CLIENT_ID, WAVE_CLIENT_SECRET, and WAVE_REDIRECT_URI are required.");
  }
  return { clientId, clientSecret, redirectUri };
}

export function buildWaveAuthorizationUrl(state: string) {
  const { clientId, redirectUri } = oauthConfig();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: WAVE_REQUESTED_SCOPES.join(" "),
    state,
    approval_prompt: "force",
  });
  return `${WAVE_AUTHORIZE_URL}?${query.toString()}`;
}

async function tokenRequest(values: Record<string, string>) {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  const response = await fetch(WAVE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, ...values }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Wave token request failed (${response.status}).`);
  return (await response.json()) as WaveTokenSet;
}

export function exchangeWaveAuthorizationCode(code: string) {
  return tokenRequest({ grant_type: "authorization_code", code });
}

export function refreshWaveAccessToken(refreshToken: string) {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

async function waveGraphql<T>(accessToken: string, query: string, variables?: Record<string, unknown>) {
  const response = await fetch(WAVE_GRAPHQL_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
    cache: "no-store",
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map((error) => error.message).join("; ") || `Wave API request failed (${response.status}).`);
  }
  return body.data;
}

export async function getWaveUserAndBusinesses(accessToken: string) {
  return waveGraphql<{
    user: { id: string };
    businesses: { edges: Array<{ node: WaveBusiness }> };
  }>(accessToken, `
    query DanceFlowWaveBusinesses {
      user { id }
      businesses(page: 1, pageSize: 100) {
        edges { node { id name isPersonal currency { code } isClassicAccounting } }
      }
    }
  `);
}

export async function getWaveAccounts(accessToken: string, businessId: string) {
  const data = await waveGraphql<{
    business: { accounts: { edges: Array<{ node: WaveAccount }> } } | null;
  }>(accessToken, `
    query DanceFlowWaveAccounts($businessId: ID!) {
      business(id: $businessId) {
        accounts(page: 1, pageSize: 100) {
          edges { node { id name isArchived normalBalanceType type { name value } subtype { name value } } }
        }
      }
    }
  `, { businessId });
  if (!data.business) throw new Error("The selected Wave business is unavailable.");
  return data.business.accounts.edges.map(({ node }) => node);
}

export class WavePostingUncertainError extends Error {}

export type WaveMoneyTransactionInput = {
  businessId: string;
  externalId: string;
  date: string;
  description: string;
  notes?: string;
  anchor: { accountId: string; amount: string; direction: "DEPOSIT" | "WITHDRAWAL" };
  lineItems: Array<{ accountId: string; amount: string; balance: "DEBIT" | "CREDIT"; description?: string }>;
};

export async function createWaveMoneyTransaction(accessToken: string, input: WaveMoneyTransactionInput) {
  let response: Response;
  try {
    response = await fetch(WAVE_GRAPHQL_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `mutation DanceFlowMoneyTransaction($input: MoneyTransactionCreateInput!) {
          moneyTransactionCreate(input: $input) {
            didSucceed
            inputErrors { path message code }
            transaction { id }
          }
        }`,
        variables: { input },
      }),
      cache: "no-store",
    });
  } catch (error) {
    throw new WavePostingUncertainError(error instanceof Error ? error.message : "Wave request did not return a response.");
  }
  if (response.status >= 500) throw new WavePostingUncertainError(`Wave returned ${response.status}.`);
  let body: { data?: { moneyTransactionCreate?: { didSucceed: boolean; inputErrors?: Array<{ path?: string; message: string; code?: string }>; transaction?: { id: string } | null } }; errors?: Array<{ message: string }> };
  try { body = await response.json(); } catch { throw new WavePostingUncertainError("Wave returned an unreadable response."); }
  if (!response.ok || body.errors?.length) throw new Error(body.errors?.map((error) => error.message).join("; ") || `Wave returned ${response.status}.`);
  const result = body.data?.moneyTransactionCreate;
  if (!result?.didSucceed || !result.transaction?.id) {
    throw new Error(result?.inputErrors?.map((error) => `${error.path ?? "input"}: ${error.message}`).join("; ") || "Wave rejected the transaction.");
  }
  return result.transaction.id;
}
