"use server";

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

type OpenAiResponse = {
  output_text?: string;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

function getOutputText(data: OpenAiResponse) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const text = data.output
    ?.flatMap((item) => item.content ?? [])
    .map((content) => content.text ?? "")
    .join("\n")
    .trim();

  return text || null;
}

export async function generateReportInsights(metrics: ReportInsightsMetrics) {
  if (process.env.AI_FEATURES_ENABLED !== "true") {
    return {
      ok: false,
      error: "AI insights are not enabled yet.",
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return {
      ok: false,
      error: "AI insights are not configured yet.",
    };
  }

  const model = process.env.OPENAI_MODEL_REPORT_INSIGHTS ?? "gpt-4.1-mini";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_output_tokens: 750,
      input: [
        {
          role: "system",
          content:
            "You are a helpful business analyst for dance studios and dance event organizers. Write concise, practical report insights in plain language. Do not mention internal implementation, model names, prompts, phases, or database details. Do not invent exact facts beyond the provided metrics. If data is limited, say what can be reviewed next.",
        },
        {
          role: "user",
          content: `Review these DanceFlow report metrics and return:\n\nSummary\nA short 2-3 sentence overview.\n\nWhat to watch\n3 short bullet points.\n\nSuggested next steps\n3-5 numbered action steps.\n\nMetrics:\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    }),
  });

  const data = (await response.json().catch(() => ({}))) as OpenAiResponse;

  if (!response.ok) {
    return {
      ok: false,
      error:
        data.error?.message ??
        "AI insights could not be generated right now. Please try again.",
    };
  }

  const text = getOutputText(data);

  if (!text) {
    return {
      ok: false,
      error: "AI insights did not return a readable response.",
    };
  }

  return {
    ok: true,
    insights: text,
  };
}
