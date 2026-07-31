import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import WorkspaceHeader from "@/components/app/workspace/WorkspaceHeader";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import {
  REWARD_RULE_TEMPLATES,
  REWARD_TYPES,
  rewardTriggerLabel,
  rewardTypeLabel,
  type RewardTriggerType,
  type RewardType,
} from "@/lib/rewards/catalog";
import {
  createRewardRuleAction,
  recordRewardEventAction,
  redeemClientRewardAction,
  toggleRewardRuleAction,
} from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type RewardRow = {
  id: string;
  name: string;
  description: string | null;
  reward_type: RewardType;
  reward_value: number | null;
  reward_config: Record<string, unknown> | null;
  active: boolean;
};

type RuleRow = {
  id: string;
  reward_id: string;
  name: string;
  description: string | null;
  trigger_type: RewardTriggerType;
  threshold_value: number;
  threshold_unit: string;
  evaluation_window: string;
  repeatable: boolean;
  active: boolean;
  created_at: string;
  studio_rewards: RewardRow | RewardRow[] | null;
};

type ClientRewardRow = {
  id: string;
  client_id: string;
  status: string;
  reward_name_snapshot: string;
  reward_type_snapshot: RewardType;
  reward_value_snapshot: number | null;
  earned_at: string;
  expires_at: string | null;
  redeemed_at: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
};

function firstJoin<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function bannerMessage(search: { success?: string; error?: string }) {
  if (search.success === "reward_activated") return "Reward rule created and activated.";
  if (search.success === "reward_created") return "Reward rule created as a draft.";
  if (search.success === "rule_activated") return "Reward rule activated.";
  if (search.success === "rule_paused") return "Reward rule paused.";
  if (search.success === "reward_event_recorded") return "Reward eligibility event recorded and processed.";
  if (search.success === "reward_redeemed") return "Reward redeemed and recorded.";

  if (search.error === "template_not_found") return "Choose a valid reward template.";
  if (search.error === "missing_fields") return "Rule name and reward name are required.";
  if (search.error === "reward_type_invalid") return "Choose a valid reward type.";
  if (search.error === "reward_value_required") return "Enter a reward value greater than zero.";
  if (search.error === "reward_percent_invalid") return "Percentage rewards cannot exceed 100%.";
  if (search.error === "reward_create_failed") return "DanceFlow could not create the reward.";
  if (search.error === "rule_create_failed") return "DanceFlow could not create the reward rule.";
  if (search.error === "rule_update_failed") return "DanceFlow could not update the reward rule.";
  if (search.error === "reward_event_missing_fields") return "Choose a client and event type.";
  if (search.error === "reward_event_invalid_type") return "That event must come from DanceFlow operational data.";
  if (search.error === "reward_event_client_not_found") return "Client not found in this studio.";
  if (search.error === "reward_event_failed") return "DanceFlow could not record the reward event.";
  if (search.error === "reward_redemption_missing") return "Choose a reward to redeem.";
  if (search.error === "reward_redemption_failed") return "DanceFlow could not redeem that reward.";

  return null;
}

function formatRewardValue(reward: RewardRow) {
  if (reward.reward_type === "points") {
    return `${Number(reward.reward_value ?? 0).toLocaleString()} points`;
  }

  if (reward.reward_type === "account_credit" || reward.reward_type === "fixed_discount") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(Number(reward.reward_value ?? 0));
  }

  if (reward.reward_type === "percent_discount") {
    return `${Number(reward.reward_value ?? 0)}%`;
  }

  return rewardTypeLabel(reward.reward_type);
}

function clientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Client";
}

function thresholdLabel(rule: RuleRow) {
  const value = Number(rule.threshold_value ?? 0);
  if (rule.threshold_unit === "currency") {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(value);
  }
  return value.toLocaleString();
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const search = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (
    !context.isPlatformAdmin &&
    role !== "studio_owner" &&
    role !== "studio_admin"
  ) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [
    { data: rulesData, error: rulesError },
    { data: earnedData, error: earnedError },
    { data: clientOptionsData, error: clientOptionsError },
  ] = await Promise.all([
    supabase
      .from("reward_rules")
      .select(`
        id,
        reward_id,
        name,
        description,
        trigger_type,
        threshold_value,
        threshold_unit,
        evaluation_window,
        repeatable,
        active,
        created_at,
        studio_rewards (
          id,
          name,
          description,
          reward_type,
          reward_value,
          reward_config,
          active
        )
      `)
      .eq("studio_id", studioId)
      .order("created_at", { ascending: false }),
    supabase
      .from("client_rewards")
      .select(`
        id,
        client_id,
        status,
        reward_name_snapshot,
        reward_type_snapshot,
        reward_value_snapshot,
        earned_at,
        expires_at,
        redeemed_at,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .order("earned_at", { ascending: false })
      .limit(250),
    supabase
      .from("clients")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead"])
      .order("first_name", { ascending: true })
      .limit(1000),
  ]);

  if (rulesError) {
    throw new Error(`Failed to load reward rules: ${rulesError.message}`);
  }

  if (earnedError) {
    throw new Error(`Failed to load earned rewards: ${earnedError.message}`);
  }

  if (clientOptionsError) {
    throw new Error(`Failed to load clients for rewards: ${clientOptionsError.message}`);
  }

  const rules = (rulesData ?? []) as unknown as RuleRow[];
  const clientRewards = (earnedData ?? []) as unknown as ClientRewardRow[];
  const clientOptions = (clientOptionsData ?? []) as ClientOption[];
  const activeRules = rules.filter((rule) => rule.active);
  const availableRewards = clientRewards.filter((reward) => reward.status === "earned");
  const redeemedRewards = clientRewards.filter((reward) => reward.status === "redeemed");
  const message = bannerMessage(search);
  const hasError = Boolean(search.error);

  return (
    <div className="space-y-6">
      {message ? (
        <div
          className={`rounded-2xl border px-4 py-3 text-sm ${
            hasError
              ? "border-rose-200 bg-rose-50 text-rose-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {message}
        </div>
      ) : null}

      <section className="overflow-hidden rounded-3xl border border-violet-200/80 bg-[linear-gradient(180deg,#faf5ff_0%,#ffffff_64%,#fff7ed_100%)] shadow-[0_18px_50px_rgba(76,29,149,0.10)]">
        <WorkspaceHeader
          eyebrow="Client loyalty"
          title="Rewards"
          description="Choose what matters to your studio, define the reward, and let DanceFlow consistently track eligibility. ARIA can surface opportunities, but it never invents reward value."
          actions={
            <Link
              href="/app/clients"
              className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              View clients
            </Link>
          }
        />

        <CompactSummaryStrip
          items={[
            {
              key: "active-rules",
              label: "Active rules",
              value: activeRules.length,
              detail: `${rules.length} configured`,
              tone: activeRules.length > 0 ? "success" : "default",
            },
            {
              key: "available",
              label: "Available rewards",
              value: availableRewards.length,
              detail: "Earned, not redeemed",
              tone: availableRewards.length > 0 ? "info" : "default",
            },
            {
              key: "redeemed",
              label: "Redeemed",
              value: redeemedRewards.length,
              detail: "Recorded redemptions",
              tone: redeemedRewards.length > 0 ? "success" : "default",
            },
            {
              key: "templates",
              label: "Templates",
              value: REWARD_RULE_TEMPLATES.length,
              detail: "Ready to configure",
            },
          ]}
        />
      </section>

      <section className="rounded-3xl border border-orange-200/70 bg-white p-5 shadow-sm md:p-6">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
            One obvious next action
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Create a reward rule
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Start from a DanceFlow template, choose the benefit, and activate it. Advanced eligibility can stay hidden until later versions need it.
          </p>
        </div>

        <form action={createRewardRuleAction} className="mt-6 grid gap-5">
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Goal</span>
              <select
                name="templateKey"
                defaultValue={REWARD_RULE_TEMPLATES[0]?.key}
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
              >
                {REWARD_RULE_TEMPLATES.map((template) => (
                  <option key={template.key} value={template.key}>
                    {template.name}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-slate-500">
                DanceFlow supplies the trigger and threshold from the selected template.
              </span>
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Rule name</span>
              <input
                name="ruleName"
                required
                placeholder="Example: 10-visit loyalty reward"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
              />
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Reward</span>
              <input
                name="rewardName"
                required
                placeholder="Example: $10 studio credit"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
              />
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Reward type</span>
              <select
                name="rewardType"
                defaultValue="account_credit"
                className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
              >
                {REWARD_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {rewardTypeLabel(type)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-semibold text-slate-900">Value</span>
              <input
                name="rewardValue"
                type="number"
                min="0"
                step="0.01"
                defaultValue="10"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                Required for points, credits, and discounts. Not required for a free class or custom perk.
              </span>
            </label>
          </div>

          <label className="block">
            <span className="text-sm font-semibold text-slate-900">Reward description</span>
            <textarea
              name="rewardDescription"
              rows={2}
              placeholder="Optional client-facing detail"
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
            />
          </label>

          <label className="flex items-start gap-3 rounded-2xl border border-violet-200 bg-violet-50/70 p-4">
            <input
              type="checkbox"
              name="active"
              defaultChecked
              className="mt-1 h-4 w-4 rounded border-violet-300 text-violet-700"
            />
            <span>
              <span className="block text-sm font-semibold text-violet-950">
                Activate after creation
              </span>
              <span className="mt-1 block text-xs leading-5 text-violet-700">
                Turn this off when you want to review the rule before it begins tracking eligibility.
              </span>
            </span>
          </label>

          <div>
            <button
              type="submit"
              className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:brightness-110"
            >
              Create reward rule
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-3xl border border-emerald-200 bg-white p-5 shadow-sm md:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">
            Fulfillment
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            Rewards ready to use
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Redemption is a staff-confirmed step. Account-credit rewards post to the existing client account ledger when redeemed; other reward types keep an auditable fulfillment record.
          </p>
        </div>

        <div className="mt-5 space-y-3">
          {availableRewards.length ? (
            availableRewards.map((reward) => (
              <div
                key={reward.id}
                className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="font-semibold text-slate-950">
                      {clientName(reward.clients)} · {reward.reward_name_snapshot}
                    </p>
                    <p className="mt-1 text-sm text-slate-600">
                      {rewardTypeLabel(reward.reward_type_snapshot)}
                      {reward.reward_value_snapshot != null
                        ? ` · ${reward.reward_type_snapshot === "percent_discount"
                            ? `${reward.reward_value_snapshot}%`
                            : reward.reward_type_snapshot === "points"
                              ? `${reward.reward_value_snapshot} points`
                              : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(reward.reward_value_snapshot)}`
                        : ""}
                      {reward.expires_at
                        ? ` · Expires ${new Date(reward.expires_at).toLocaleDateString()}`
                        : ""}
                    </p>
                  </div>

                  <form action={redeemClientRewardAction} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="clientRewardId" value={reward.id} />
                    <input
                      name="note"
                      placeholder="Optional note"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                    >
                      Redeem
                    </button>
                  </form>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-2xl border border-dashed border-emerald-200 bg-emerald-50/30 p-6 text-center text-sm text-slate-600">
              No earned rewards are waiting for redemption.
            </div>
          )}
        </div>
      </section>

      <details className="group rounded-3xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 md:p-6">
          <span>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Exceptions only
            </span>
            <span className="mt-1 block text-xl font-semibold text-slate-950">
              Confirm an external reward event
            </span>
            <span className="mt-1 block text-sm text-slate-600">
              Use only when DanceFlow cannot verify the event itself, such as an external referral conversion or completion of an eligible feedback/review workflow.
            </span>
          </span>
          <span aria-hidden="true" className="text-2xl text-slate-400 transition group-open:rotate-45">
            +
          </span>
        </summary>

        <form action={recordRewardEventAction} className="grid gap-4 border-t border-slate-200 p-5 md:grid-cols-2 md:p-6">
          <label className="block">
            <span className="text-sm font-semibold text-slate-900">Client</span>
            <select
              name="clientId"
              required
              defaultValue=""
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
            >
              <option value="">Choose a client…</option>
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.first_name} {client.last_name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-semibold text-slate-900">Verified event</span>
            <select
              name="triggerType"
              defaultValue="referral_converted"
              className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
            >
              <option value="referral_converted">Referral converted</option>
              <option value="review_or_feedback_completed">Eligible feedback/review workflow completed</option>
            </select>
          </label>

          <label className="block md:col-span-2">
            <span className="text-sm font-semibold text-slate-900">Verification note</span>
            <input
              name="note"
              required
              placeholder="What staff verified"
              className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm"
            />
          </label>

          <div className="md:col-span-2">
            <button
              type="submit"
              className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-semibold text-violet-800 hover:bg-violet-100"
            >
              Record verified event
            </button>
          </div>
        </form>
      </details>

      <section className="rounded-3xl border border-violet-200 bg-white p-5 shadow-sm md:p-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
            Configured rules
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
            What DanceFlow is tracking
          </h2>
        </div>

        <div className="mt-5 space-y-3">
          {rules.length ? (
            rules.map((rule) => {
              const reward = firstJoin(rule.studio_rewards);

              return (
                <div
                  key={rule.id}
                  className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4"
                >
                  <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-semibold text-[var(--brand-text)]">{rule.name}</p>
                        <span
                          className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                            rule.active
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {rule.active ? "Active" : "Paused"}
                        </span>
                        {rule.repeatable ? (
                          <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700">
                            Repeatable
                          </span>
                        ) : null}
                      </div>

                      <p className="mt-2 text-sm text-slate-600">
                        {rewardTriggerLabel(rule.trigger_type)} · Threshold {thresholdLabel(rule)} · {rule.evaluation_window.replaceAll("_", " ")}
                      </p>

                      {reward ? (
                        <p className="mt-2 text-sm font-semibold text-slate-900">
                          Reward: {reward.name} · {formatRewardValue(reward)}
                        </p>
                      ) : null}
                    </div>

                    <form action={toggleRewardRuleAction}>
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <input type="hidden" name="nextActive" value={rule.active ? "false" : "true"} />
                      <button
                        type="submit"
                        className={`rounded-xl px-4 py-2 text-sm font-semibold ${
                          rule.active
                            ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                            : "bg-violet-700 text-white hover:bg-violet-800"
                        }`}
                      >
                        {rule.active ? "Pause" : "Activate"}
                      </button>
                    </form>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="rounded-2xl border border-dashed border-violet-200 bg-violet-50/40 p-8 text-center">
              <p className="font-semibold text-slate-950">No reward rules yet</p>
              <p className="mt-2 text-sm text-slate-600">
                Create the first rule above. DanceFlow will not invent or activate a reward you did not configure.
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
