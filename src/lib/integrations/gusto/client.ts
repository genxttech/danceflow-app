import "server-only";

const GUSTO_API_VERSION = "2026-06-15";

export type GustoTokenSet = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type: string;
  resource_uuid?: string;
  resource_type?: string;
};

export type GustoTokenInfo = {
  resource_uuid?: string;
  resource_type?: string;
  resource?: {
    uuid?: string;
    type?: string;
  } | null;
  resource_owner?: {
    uuid?: string;
    type?: string;
  } | null;
  scope?: string | string[];
  scopes?: string[];
};

export type GustoCompany = {
  uuid: string;
  name: string;
  trade_name?: string | null;
};

function environment() {
  return process.env.GUSTO_ENVIRONMENT === "production" ? "production" : "demo";
}

export function gustoEnvironment() {
  return environment();
}

function apiBase() {
  return environment() === "production"
    ? "https://api.gusto.com"
    : "https://api.gusto-demo.com";
}

function oauthConfig() {
  const clientId = process.env.GUSTO_CLIENT_ID;
  const clientSecret = process.env.GUSTO_CLIENT_SECRET;
  const redirectUri = process.env.GUSTO_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "GUSTO_CLIENT_ID, GUSTO_CLIENT_SECRET, and GUSTO_REDIRECT_URI are required.",
    );
  }

  return { clientId, clientSecret, redirectUri };
}

export function buildGustoAuthorizationUrl(state: string) {
  const { clientId, redirectUri } = oauthConfig();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    state,
  });

  return `${apiBase()}/oauth/authorize?${query.toString()}`;
}

async function tokenRequest(values: Record<string, string>) {
  const { clientId, clientSecret, redirectUri } = oauthConfig();
  const response = await fetch(`${apiBase()}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Gusto-API-Version": GUSTO_API_VERSION,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      ...values,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Gusto token request failed (${response.status}).`);
  }

  return (await response.json()) as GustoTokenSet;
}

export function exchangeGustoAuthorizationCode(code: string) {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
  });
}

export function refreshGustoAccessToken(refreshToken: string) {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function gustoGet<T>(accessToken: string, path: string) {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "X-Gusto-API-Version": GUSTO_API_VERSION,
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`Gusto API request failed (${response.status}).`);
  }

  return (await response.json()) as T;
}

export function getGustoTokenInfo(accessToken: string) {
  return gustoGet<GustoTokenInfo>(accessToken, "/v1/token_info");
}

export function getGustoCompany(accessToken: string, companyUuid: string) {
  return gustoGet<GustoCompany>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}`,
  );
}

export function normalizedGustoScopes(
  token: GustoTokenSet,
  info: GustoTokenInfo,
) {
  const values = [
    ...(token.scope?.split(/\s+/).filter(Boolean) ?? []),
    ...(Array.isArray(info.scope)
      ? info.scope
      : typeof info.scope === "string"
        ? info.scope.split(/\s+/).filter(Boolean)
        : []),
    ...(info.scopes ?? []),
  ];

  return Array.from(new Set(values));
}

export function gustoCompanyUuid(
  token: GustoTokenSet,
  info: GustoTokenInfo,
) {
  const resourceType = String(
    info.resource?.type ??
      info.resource_type ??
      token.resource_type ??
      "",
  ).toLowerCase();

  const uuid =
    info.resource?.uuid ??
    info.resource_uuid ??
    token.resource_uuid ??
    null;

  return resourceType === "company" && uuid ? uuid : null;
}


export type GustoWorker = {
  uuid: string;
  worker_type: "employee" | "contractor";
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  active: boolean;
  onboarding_status: string | null;
};

type GustoEmployeeApiRow = {
  uuid?: string;
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  personal_email?: string | null;
  work_email?: string | null;
  terminated_on?: string | null;
  termination_date?: string | null;
  onboarding_status?: string | null;
};

type GustoContractorApiRow = {
  uuid?: string;
  id?: string;
  type?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  business_name?: string | null;
  email?: string | null;
  is_active?: boolean | null;
  active?: boolean | null;
  dismissal_date?: string | null;
  onboarding_status?: string | null;
};


export type GustoCreatedEmployee = {
  uuid?: string;
  id?: string;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  work_email?: string | null;
  onboarding_status?: string | null;
};

export async function createGustoDemoEmployee(
  accessToken: string,
  companyUuid: string,
  input: { firstName: string; lastName: string; email: string },
) {
  if (gustoEnvironment() !== "demo") {
    throw new Error("Test workers can only be created in the Gusto demo environment.");
  }

  const response = await fetch(
    `${apiBase()}/v1/companies/${encodeURIComponent(companyUuid)}/employees`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Gusto-API-Version": GUSTO_API_VERSION,
      },
      body: JSON.stringify({
        first_name: input.firstName,
        last_name: input.lastName,
        email: input.email,
        self_onboarding: false,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gusto employee creation failed (${response.status})${detail ? `: ${detail.slice(0, 500)}` : "."}`,
    );
  }

  return (await response.json()) as GustoCreatedEmployee;
}

export async function getGustoWorkers(
  accessToken: string,
  companyUuid: string,
): Promise<GustoWorker[]> {
  const company = encodeURIComponent(companyUuid);
  const [employees, contractors] = await Promise.all([
    gustoGet<GustoEmployeeApiRow[]>(
      accessToken,
      `/v1/companies/${company}/employees`,
    ),
    gustoGet<GustoContractorApiRow[]>(
      accessToken,
      `/v1/companies/${company}/contractors`,
    ),
  ]);

  const employeeRows = employees
    .map((row): GustoWorker | null => {
      const uuid = row.uuid ?? row.id;
      if (!uuid) return null;
      return {
        uuid,
        worker_type: "employee",
        first_name: row.first_name ?? null,
        last_name: row.last_name ?? null,
        email: row.work_email ?? row.email ?? row.personal_email ?? null,
        active: !(row.terminated_on ?? row.termination_date),
        onboarding_status: row.onboarding_status ?? null,
      };
    })
    .filter((row): row is GustoWorker => Boolean(row));

  const contractorRows = contractors
    .map((row): GustoWorker | null => {
      const uuid = row.uuid ?? row.id;
      if (!uuid) return null;
      const business = String(row.type ?? "").toLowerCase() === "business";
      return {
        uuid,
        worker_type: "contractor",
        first_name: business ? row.business_name ?? null : row.first_name ?? null,
        last_name: business ? null : row.last_name ?? null,
        email: row.email ?? null,
        active:
          row.active ?? row.is_active ?? !row.dismissal_date,
        onboarding_status: row.onboarding_status ?? null,
      };
    })
    .filter((row): row is GustoWorker => Boolean(row));

  return [...employeeRows, ...contractorRows];
}
