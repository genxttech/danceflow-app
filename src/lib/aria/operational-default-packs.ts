import {
  ARIA_OPERATIONAL_AUTOMATION_MATRIX,
  type AriaDeliveryMode,
  type AriaOperationalArea,
  type AriaOperationalAutomation,
} from "./operational-automation-matrix";

export type AriaPackMode =
  | "handle_automatically"
  | "prepare_for_review"
  | "notify_only"
  | "off";

export type AriaOperationalPackRule = {
  ruleKey: string;
  defaultMode: AriaPackMode;
  defaultDeliveryMode: AriaDeliveryMode;
  enabledByDefault: boolean;
  ownerExplanation: string;
  advancedSettings?: {
    timing?: string;
    threshold?: string;
    channels?: string[];
    exceptions?: string[];
  };
};

export type AriaOperationalPack = {
  packKey: AriaOperationalArea;
  label: string;
  shortDescription: string;
  ownerOutcome: string;
  recommendedMode: AriaPackMode;
  recommendedLabel: string;
  enabledByDefault: boolean;
  setupQuestion?: {
    prompt: string;
    options: Array<{
      value: string;
      label: string;
      description: string;
    }>;
    recommendedValue: string;
  };
  rules: AriaOperationalPackRule[];
};

const DELIVERY_TO_PACK_MODE: Record<AriaDeliveryMode, AriaPackMode> = {
  internal_only: "notify_only",
  suggestion_only: "prepare_for_review",
  draft_for_review: "prepare_for_review",
  auto_send: "handle_automatically",
};

const PACK_PRESENTATION: Record<
  AriaOperationalArea,
  {
    label: string;
    shortDescription: string;
    ownerOutcome: string;
    recommendedMode: AriaPackMode;
    recommendedLabel: string;
    enabledByDefault: boolean;
  }
> = {
  front_desk: {
    label: "Front Desk",
    shortDescription:
      "Keeps booking requests, confirmations, cancellations, and routine follow-up moving.",
    ownerOutcome: "Clients receive timely service without every item reaching the owner.",
    recommendedMode: "prepare_for_review",
    recommendedLabel: "ARIA prepares routine follow-up and handles safe reminders.",
    enabledByDefault: true,
  },
  client_relations: {
    label: "Client Relationships",
    shortDescription:
      "Welcomes new clients, follows up after lessons, and supports service recovery.",
    ownerOutcome: "Clients feel cared for even when the studio is busy.",
    recommendedMode: "handle_automatically",
    recommendedLabel: "ARIA handles standard relationship follow-up automatically.",
    enabledByDefault: true,
  },
  scheduling: {
    label: "Scheduling",
    shortDescription:
      "Surfaces conflicts, coverage gaps, waitlists, and capacity issues.",
    ownerOutcome: "Scheduling problems are found early and only judgment calls reach staff.",
    recommendedMode: "notify_only",
    recommendedLabel: "ARIA detects issues and brings staff the best next options.",
    enabledByDefault: true,
  },
  sales_retention: {
    label: "Sales and Retention",
    shortDescription:
      "Rebooks active dancers, protects renewals, and reactivates appropriate clients.",
    ownerOutcome: "Revenue opportunities receive consistent follow-through.",
    recommendedMode: "handle_automatically",
    recommendedLabel: "ARIA handles safe outreach and prepares judgment-based campaigns.",
    enabledByDefault: true,
  },
  marketing: {
    label: "Marketing",
    shortDescription:
      "Finds campaign opportunities and prepares relevant audience and content suggestions.",
    ownerOutcome: "Marketing support appears when there is a real business opportunity.",
    recommendedMode: "prepare_for_review",
    recommendedLabel: "ARIA prepares campaigns for approval before anything is sent.",
    enabledByDefault: true,
  },
  billing_payments: {
    label: "Billing and Payments",
    shortDescription:
      "Follows up on safe payment reminders and escalates financial exceptions.",
    ownerOutcome: "Payment problems are handled promptly without unsafe automatic financial changes.",
    recommendedMode: "notify_only",
    recommendedLabel: "ARIA handles reminders but escalates financial decisions.",
    enabledByDefault: true,
  },
  documents: {
    label: "Documents",
    shortDescription:
      "Reminds clients about signatures and surfaces expiring or superseded documents.",
    ownerOutcome: "Required paperwork is completed without manual tracking.",
    recommendedMode: "handle_automatically",
    recommendedLabel: "ARIA sends routine reminders and escalates document exceptions.",
    enabledByDefault: true,
  },
  events: {
    label: "Events",
    shortDescription:
      "Tracks registration, payment, attendance, cost, and profitability exceptions.",
    ownerOutcome: "Event issues are visible before they affect attendance or profitability.",
    recommendedMode: "notify_only",
    recommendedLabel: "ARIA monitors events and escalates exceptions.",
    enabledByDefault: true,
  },
  staff_payroll: {
    label: "Staff and Payroll",
    shortDescription:
      "Finds missing payroll data, overdue staff tasks, and coverage gaps.",
    ownerOutcome: "Payroll and staff coordination are prepared before deadlines.",
    recommendedMode: "notify_only",
    recommendedLabel: "ARIA detects gaps and prepares staff follow-up.",
    enabledByDefault: true,
  },
  retail_inventory: {
    label: "Retail and Inventory",
    shortDescription:
      "Monitors low stock, fulfillment delays, and entitlement failures.",
    ownerOutcome: "Commerce exceptions are caught without constant inventory checking.",
    recommendedMode: "prepare_for_review",
    recommendedLabel: "ARIA prepares reorder and fulfillment actions for review.",
    enabledByDefault: true,
  },
  studio_health: {
    label: "Studio Health",
    shortDescription:
      "Finds data-quality issues, app-adoption gaps, and post-migration exceptions.",
    ownerOutcome: "The studio stays operationally healthy without manual audits.",
    recommendedMode: "notify_only",
    recommendedLabel: "ARIA fixes deterministic issues and escalates ambiguous ones.",
    enabledByDefault: true,
  },
};

const SETUP_QUESTIONS: Partial<
  Record<AriaOperationalArea, AriaOperationalPack["setupQuestion"]>
> = {
  front_desk: {
    prompt: "How should ARIA handle routine front-desk communication?",
    options: [
      {
        value: "auto_safe",
        label: "Send safe reminders automatically",
        description:
          "ARIA sends standard confirmations and reminders, then asks for help with exceptions.",
      },
      {
        value: "review_all",
        label: "Prepare everything for review",
        description:
          "ARIA drafts the work, but staff sends every client-facing message.",
      },
    ],
    recommendedValue: "auto_safe",
  },
  marketing: {
    prompt: "How should ARIA help with marketing?",
    options: [
      {
        value: "draft_only",
        label: "Prepare campaigns for review",
        description:
          "ARIA identifies opportunities and creates drafts, but nothing is sent automatically.",
      },
      {
        value: "suggest_only",
        label: "Suggest opportunities only",
        description:
          "ARIA surfaces ideas without preparing audience or campaign content.",
      },
    ],
    recommendedValue: "draft_only",
  },
  billing_payments: {
    prompt: "How should ARIA handle payment follow-up?",
    options: [
      {
        value: "reminders_only",
        label: "Send routine reminders only",
        description:
          "ARIA may send approved reminders, but never charges, refunds, retries, waives, or changes access.",
      },
      {
        value: "review_all",
        label: "Prepare reminders for review",
        description:
          "Staff reviews every payment-related message before delivery.",
      },
    ],
    recommendedValue: "reminders_only",
  },
};

function getAutomation(ruleKey: string) {
  return (
    ARIA_OPERATIONAL_AUTOMATION_MATRIX.find(
      (automation) =>
        automation.ruleKey === ruleKey ||
        automation.existingRuleKeys?.includes(ruleKey),
    ) ?? null
  );
}

function toPackRule(
  automation: AriaOperationalAutomation,
): AriaOperationalPackRule {
  return {
    ruleKey: automation.ruleKey,
    defaultMode: DELIVERY_TO_PACK_MODE[automation.defaultDeliveryMode],
    defaultDeliveryMode: automation.defaultDeliveryMode,
    enabledByDefault: automation.enabledByDefault,
    ownerExplanation: automation.ownerOutcome,
    advancedSettings: {
      timing: automation.cadence,
      channels:
        automation.defaultDeliveryMode === "auto_send" ||
        automation.defaultDeliveryMode === "draft_for_review"
          ? ["email", "in_app"]
          : ["in_app"],
      exceptions: [automation.escalationCondition],
    },
  };
}

export const ARIA_OPERATIONAL_DEFAULT_PACKS: AriaOperationalPack[] =
  Object.entries(PACK_PRESENTATION).map(([areaKey, presentation]) => {
    const packKey = areaKey as AriaOperationalArea;
    const automations = ARIA_OPERATIONAL_AUTOMATION_MATRIX.filter(
      (automation) => automation.area === packKey,
    );

    return {
      packKey,
      ...presentation,
      setupQuestion: SETUP_QUESTIONS[packKey],
      rules: automations.map(toPackRule),
    };
  });

export function getAriaOperationalPack(packKey: AriaOperationalArea) {
  return (
    ARIA_OPERATIONAL_DEFAULT_PACKS.find((pack) => pack.packKey === packKey) ??
    null
  );
}

export function getAriaOperationalPackRule(ruleKey: string) {
  for (const pack of ARIA_OPERATIONAL_DEFAULT_PACKS) {
    const rule = pack.rules.find((item) => item.ruleKey === ruleKey);
    if (rule) return { pack, rule, automation: getAutomation(ruleKey) };
  }

  return null;
}

export function getAriaEnabledDefaultRuleKeys() {
  return ARIA_OPERATIONAL_DEFAULT_PACKS.flatMap((pack) =>
    pack.enabledByDefault
      ? pack.rules
          .filter((rule) => rule.enabledByDefault)
          .map((rule) => rule.ruleKey)
      : [],
  );
}

export function getAriaPackSummary() {
  return ARIA_OPERATIONAL_DEFAULT_PACKS.map((pack) => ({
    packKey: pack.packKey,
    label: pack.label,
    enabledByDefault: pack.enabledByDefault,
    totalRules: pack.rules.length,
    autoHandledRules: pack.rules.filter(
      (rule) => rule.defaultMode === "handle_automatically",
    ).length,
    reviewRules: pack.rules.filter(
      (rule) => rule.defaultMode === "prepare_for_review",
    ).length,
    notifyRules: pack.rules.filter(
      (rule) => rule.defaultMode === "notify_only",
    ).length,
  }));
}
