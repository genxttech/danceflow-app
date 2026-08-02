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

function environment(): "demo" | "production" {
  const value = process.env.GUSTO_ENVIRONMENT?.trim().toLowerCase();

  if (value === "demo" || value === "production") {
    return value;
  }

  throw new Error(
    "GUSTO_ENVIRONMENT must be explicitly set to demo or production.",
  );
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


export type GustoPaySchedule = {
  uuid: string;
  name: string | null;
  frequency: string | null;
  active: boolean;
};

export type GustoPayPeriod = {
  uuid: string | null;
  pay_schedule_uuid: string | null;
  start_date: string;
  end_date: string;
  pay_date: string | null;
};

export type GustoWorkerJob = {
  uuid: string;
  title: string | null;
  hire_date: string | null;
  termination_date: string | null;
  active: boolean;
};

type GustoPayScheduleApiRow = {
  uuid?: string;
  id?: string;
  name?: string | null;
  frequency?: string | null;
  active?: boolean | null;
  is_active?: boolean | null;
};

type GustoPayPeriodApiRow = {
  uuid?: string | null;
  id?: string | null;
  pay_schedule_uuid?: string | null;
  pay_schedule_id?: string | null;
  start_date?: string;
  end_date?: string;
  pay_date?: string | null;
};

type GustoEmployeeDetailApi = {
  jobs?: Array<{
    uuid?: string;
    id?: string;
    title?: string | null;
    hire_date?: string | null;
    termination_date?: string | null;
    terminated_on?: string | null;
    active?: boolean | null;
  }>;
};

export async function getGustoPaySchedules(
  accessToken: string,
  companyUuid: string,
): Promise<GustoPaySchedule[]> {
  const rows = await gustoGet<GustoPayScheduleApiRow[]>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/pay_schedules`,
  );
  return rows.flatMap((row) => {
    const uuid = row.uuid ?? row.id;
    if (!uuid) return [];
    return [{
      uuid,
      name: row.name ?? null,
      frequency: row.frequency ?? null,
      active: row.active ?? row.is_active ?? true,
    }];
  });
}

export async function getGustoPayPeriods(
  accessToken: string,
  companyUuid: string,
  startDate: string,
  endDate: string,
): Promise<GustoPayPeriod[]> {
  const query = new URLSearchParams({ start_date: startDate, end_date: endDate });
  const rows = await gustoGet<GustoPayPeriodApiRow[]>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/pay_periods?${query.toString()}`,
  );
  return rows.flatMap((row) => {
    if (!row.start_date || !row.end_date) return [];
    return [{
      uuid: row.uuid ?? row.id ?? null,
      pay_schedule_uuid: row.pay_schedule_uuid ?? row.pay_schedule_id ?? null,
      start_date: row.start_date,
      end_date: row.end_date,
      pay_date: row.pay_date ?? null,
    }];
  });
}

export async function getGustoEmployeeJobs(
  accessToken: string,
  employeeUuid: string,
): Promise<GustoWorkerJob[]> {
  const employee = await gustoGet<GustoEmployeeDetailApi>(
    accessToken,
    `/v1/employees/${encodeURIComponent(employeeUuid)}`,
  );
  return (employee.jobs ?? []).flatMap((row) => {
    const uuid = row.uuid ?? row.id;
    if (!uuid) return [];
    const terminationDate = row.termination_date ?? row.terminated_on ?? null;
    return [{
      uuid,
      title: row.title ?? null,
      hire_date: row.hire_date ?? null,
      termination_date: terminationDate,
      active: row.active ?? !terminationDate,
    }];
  });
}


export type GustoTimeSheetPayload = {
  entity_uuid: string;
  entity_type: "Employee" | "Contractor";
  job_uuid?: string | null;
  time_zone: string;
  shift_started_at: string;
  shift_ended_at?: string | null;
  metadata?: Record<string, string>;
  entries: Array<{
    hours_worked: number;
    pay_classification: "Regular" | "Overtime" | "Double overtime";
  }>;
};

export type GustoTimeSheet = {
  uuid?: string;
  id?: string;
  entity_uuid?: string;
  entity_type?: string;
  job_uuid?: string | null;
  shift_started_at?: string;
  shift_ended_at?: string | null;
  metadata?: Record<string, string> | null;
  status?: string | null;
  synced_at?: string | null;
  [key: string]: unknown;
};

export async function createGustoTimeSheet(
  accessToken: string,
  companyUuid: string,
  payload: GustoTimeSheetPayload,
): Promise<GustoTimeSheet> {
  const response = await fetch(
    `${apiBase()}/v1/companies/${encodeURIComponent(companyUuid)}/time_tracking/time_sheets`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Gusto-API-Version": GUSTO_API_VERSION,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gusto time sheet creation failed (${response.status})${detail ? `: ${detail.slice(0, 700)}` : "."}`,
    );
  }

  return (await response.json()) as GustoTimeSheet;
}

export async function getGustoCompanyTimeSheets(
  accessToken: string,
  companyUuid: string,
  entityUuid?: string,
): Promise<GustoTimeSheet[]> {
  const query = new URLSearchParams({
    sort_by: "created_at",
    sort_order: "desc",
    per: "100",
  });
  if (entityUuid) query.append("entity_uuids[]", entityUuid);

  return gustoGet<GustoTimeSheet[]>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/time_tracking/time_sheets?${query.toString()}`,
  );
}

export async function findGustoTimeSheetByDanceFlowKey(
  accessToken: string,
  companyUuid: string,
  entityUuid: string,
  deliveryKey: string,
) {
  const rows = await getGustoCompanyTimeSheets(
    accessToken,
    companyUuid,
    entityUuid,
  );

  return (
    rows.find(
      (row) =>
        row.metadata?.danceflow_delivery_key === deliveryKey,
    ) ?? null
  );
}


export type GustoJob = {
  uuid?: string;
  id?: string;
  employee_uuid?: string;
  title?: string;
  hire_date?: string;
  primary?: boolean;
  [key: string]: unknown;
};

export async function createGustoEmployeeJob(
  accessToken: string,
  employeeUuid: string,
  input: {
    title: string;
    hireDate: string;
  },
): Promise<GustoJob> {
  const response = await fetch(
    `${apiBase()}/v1/employees/${encodeURIComponent(employeeUuid)}/jobs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Gusto-API-Version": GUSTO_API_VERSION,
      },
      body: JSON.stringify({
        title: input.title,
        hire_date: input.hireDate,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gusto job creation failed (${response.status})${detail ? `: ${detail.slice(0, 700)}` : "."}`,
    );
  }

  return (await response.json()) as GustoJob;
}


export type GustoPayrollSync = {
  uuid?: string;
  id?: string;
  status?: string;
  kind?: string;
  pay_schedule_uuid?: string;
  pay_period_start_date?: string;
  pay_period_end_date?: string;
  payroll_uuid?: string | null;
  error?: string | null;
  errors?: unknown;
  [key: string]: unknown;
};

export async function createGustoPayrollSync(
  accessToken: string,
  companyUuid: string,
  input: {
    payScheduleUuid: string;
    payPeriodStartDate: string;
    payPeriodEndDate: string;
  },
): Promise<GustoPayrollSync> {
  const response = await fetch(
    `${apiBase()}/v1/companies/${encodeURIComponent(companyUuid)}/time_tracking/payroll_syncs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Gusto-API-Version": GUSTO_API_VERSION,
      },
      body: JSON.stringify({
        kind: "regular",
        pay_schedule_uuid: input.payScheduleUuid,
        pay_period_start_date: input.payPeriodStartDate,
        pay_period_end_date: input.payPeriodEndDate,
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gusto payroll sync creation failed (${response.status})${detail ? `: ${detail.slice(0, 900)}` : "."}`,
    );
  }

  return (await response.json()) as GustoPayrollSync;
}

export async function getGustoPayrollSync(
  accessToken: string,
  payrollSyncUuid: string,
): Promise<GustoPayrollSync> {
  return gustoGet<GustoPayrollSync>(
    accessToken,
    `/v1/time_tracking/payroll_syncs/${encodeURIComponent(payrollSyncUuid)}`,
  );
}


export async function getGustoTimeSheet(
  accessToken: string,
  timeSheetUuid: string,
): Promise<GustoTimeSheet> {
  return gustoGet<GustoTimeSheet>(
    accessToken,
    `/v1/time_tracking/time_sheets/${encodeURIComponent(timeSheetUuid)}`,
  );
}

export async function approveGustoTimeSheet(
  accessToken: string,
  timeSheet: GustoTimeSheet,
): Promise<GustoTimeSheet> {
  const timeSheetUuid =
    typeof timeSheet.uuid === "string"
      ? timeSheet.uuid
      : typeof timeSheet.id === "string"
        ? timeSheet.id
        : null;
  const version =
    typeof timeSheet.version === "string" ? timeSheet.version : null;

  if (!timeSheetUuid || !version) {
    throw new Error(
      "Gusto time sheet approval requires the current UUID and version.",
    );
  }

  const response = await fetch(
    `${apiBase()}/v1/time_tracking/time_sheets/${encodeURIComponent(timeSheetUuid)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Gusto-API-Version": GUSTO_API_VERSION,
      },
      body: JSON.stringify({
        version,
        status: "approved",
      }),
      cache: "no-store",
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gusto time sheet approval failed (${response.status})${detail ? `: ${detail.slice(0, 900)}` : "."}`,
    );
  }

  return (await response.json()) as GustoTimeSheet;
}


export type GustoPayrollSummary = {
  uuid?: string;
  id?: string;
  payroll_uuid?: string;
  pay_period?: {
    start_date?: string;
    end_date?: string;
  } | null;
  pay_period_start_date?: string;
  pay_period_end_date?: string;
  processing_status?: string;
  payroll_type?: string;
  [key: string]: unknown;
};

export async function getGustoUnprocessedPayrolls(
  accessToken: string,
  companyUuid: string,
  startDate: string,
  endDate: string,
): Promise<GustoPayrollSummary[]> {
  const query = new URLSearchParams();
  query.set("processing_statuses", "unprocessed");
  query.set("payroll_types", "regular");
  query.set("start_date", startDate);
  query.set("end_date", endDate);
  query.set("per", "100");

  return gustoGet<GustoPayrollSummary[]>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/payrolls?${query.toString()}`,
  );
}

export type GustoPayrollEmployee = {
  uuid?: string;
  id?: string;
};

export async function getGustoPayrollEmployees(
  accessToken: string,
  companyUuid: string,
  payrollUuid: string,
): Promise<GustoPayrollEmployee[]> {
  const query = new URLSearchParams({
    payroll_uuid: payrollUuid,
    per: "100",
  });

  return gustoGet<GustoPayrollEmployee[]>(
    accessToken,
    `/v1/companies/${encodeURIComponent(companyUuid)}/employees?${query.toString()}`,
  );
}
