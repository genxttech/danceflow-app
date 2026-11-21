"use server";

import { checkRateLimit, getServerActionRateLimitKey, rateLimitErrorMessage } from "@/lib/security/rate-limit";
import { callOpenAiResponses } from "@/lib/ai/providerCall";
import { studioHasFeature } from "@/lib/billing/access";
import { getUsageAllowance, getUsageLimitMessage, recordUsageEvent } from "@/lib/usage/addons";
export type ReportInsightsMetrics = {
  range: string;
  plan: string;
  revenue: {
    total: number;
    studioPayments: number;
    eventTickets: number;
    floorRental: number;
    refunds: number;
    averageStudioPayment: number;
  };
  expenses: {
    total: number;
    floorFees: number;
    other: number;
    knownFees: number;
  };
  profitAndLoss: {
    estimatedNetIncome: number;
    instructorCompensation?: number;
    netAfterInstructorCompensation?: number;
  };
  attendance: {
    rate: string;
    attended: number;
    cancelled: number;
    noShows: number;
    scheduled: number;
  };
  clientsAndLeads: {
    activeStudents: number;
    newLeadRecords: number;
    leads: number;
    converted: number;
    archived: number;
    conversionRate: string;
  };
  events: {
    paidRegistrations: number;
    checkedIn: number;
    noShows: number;
    attendanceRate: string;
    topEvents: Array<{
      name: string;
      revenue: number;
      registrations: number;
      checkedIn: number;
      noShows: number;
    }>;
    topTickets: Array<{
      name: string;
      revenue: number;
      quantity: number;
    }>;
  };
  instructors: {
    count: number;
    totalLessons: number;
    attendedLessons: number;
    totalRevenue: number;
    attendanceRate: string;
    compensation?: {
      pending: number;
      approved: number;
      paid: number;
      outstanding: number;
      activeTotal: number;
    };
    topInstructors: Array<{
      name: string;
      lessons: number;
      attended: number;
      noShows: number;
      revenue: number;
    }>;
  };
  organizer: null | {
    revenue: number;
    paidRegistrations: number;
    checkedIn: number;
    noShows: number;
    attendanceRate: string;
    contacts: number;
    campaignsSent: number;
    campaignRecipientsSent: number;
    campaignRecipientsFailed: number;
    campaignRecipientsSuppressed: number;
  };
};

export async function generateReportInsights(metrics: ReportInsightsMetrics) {
  const canUseAi = await studioHasFeature("ai_assistant");

  if (!canUseAi) {
    return {
      ok: false,
      error: "AI report insights is available on Growth and Pro plans.",
    };
  }

  const allowance = await getUsageAllowance({ featureKey: "ai_action" });

  if (!allowance.allowed) {
    return {
      ok: false,
      error: getUsageLimitMessage(allowance, "AI action"),
    };
  }

  if (!metrics || typeof metrics !== "object" || JSON.stringify(metrics).length > 12000) {
    return { ok: false, error: "That report is too large for AI insights." };
  }

  const model = process.env.OPENAI_MODEL_REPORT_INSIGHTS ?? "gpt-4.1-mini";

  const rateLimit = checkRateLimit(
    await getServerActionRateLimitKey("ai:report-insights", [metrics.range, metrics.plan]),
    { limit: 8, windowMs: 10 * 60 * 1000 },
  );

  if (!rateLimit.allowed) {
    return { ok: false, error: rateLimitErrorMessage(rateLimit) };
  }

  const result = await callOpenAiResponses({
    feature: "report_insights",
    model,
    temperature: 0.3,
    maxOutputTokens: 750,
    maxInputChars: 20000,
    input: [
        {
          role: "system",
          content:
            "You are a helpful business analyst for dance studios and dance event organizers. Write concise, practical report insights in plain language. Include instructor compensation/labor cost observations when the metrics include them. Do not call this tax payroll processing. Do not mention internal implementation, model names, prompts, phases, or database details. Do not invent exact facts beyond the provided metrics. If data is limited, say what can be reviewed next.",
        },
        {
          role: "user",
          content: `Review these DanceFlow report metrics and return:\n\nSummary\nA short 2-3 sentence overview.\n\nWhat to watch\n3 short bullet points.\n\nSuggested next steps\n3-5 numbered action steps.\n\nMetrics:\n${JSON.stringify(metrics, null, 2)}`,
        },
    ],
  });

  if (!result.ok) {
    return { ok: false, error: result.message };
  }

  const text = result.text;

  await recordUsageEvent({
    featureKey: "ai_action",
    source: "report_ai_insights",
    metadata: { range: String(metrics?.range ?? "").slice(0, 40) },
  });

  return {
    ok: true,
    insights: text,
  };
}
