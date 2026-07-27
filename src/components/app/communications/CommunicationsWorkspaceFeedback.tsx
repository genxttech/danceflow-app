import { AlertCircle, CheckCircle2, Info } from "lucide-react";

type FeedbackTone = "success" | "error" | "info";

const toneStyles: Record<FeedbackTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  error: "border-rose-200 bg-rose-50 text-rose-900",
  info: "border-sky-200 bg-sky-50 text-sky-900",
};

export default function CommunicationsWorkspaceFeedback({
  tone,
  message,
}: {
  tone: FeedbackTone;
  message: string;
}) {
  const Icon =
    tone === "success" ? CheckCircle2 : tone === "error" ? AlertCircle : Info;

  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm font-medium shadow-sm ${toneStyles[tone]}`}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="leading-6">{message}</p>
    </div>
  );
}
