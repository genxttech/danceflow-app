"use client";

import { useState } from "react";
import { useParams } from "next/navigation";

export default function AppointmentConfirmationPage() {
  const params = useParams<{ token: string }>();
  const [state, setState] = useState<"ready" | "loading" | "confirmed" | "error">("ready");
  const [message, setMessage] = useState("Confirm that you plan to attend this appointment.");

  async function confirm() {
    setState("loading");

    try {
      const response = await fetch(
        `/api/appointments/confirm/${encodeURIComponent(params.token)}`,
        { method: "POST" },
      );
      const payload = (await response.json()) as { error?: string };

      if (!response.ok) throw new Error(payload.error || "Confirmation failed.");

      setState("confirmed");
      setMessage("Your appointment is confirmed. The studio has been updated.");
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Confirmation failed.");
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-5 py-12">
      <section className="w-full overflow-hidden rounded-[32px] border border-violet-200 bg-white shadow-xl">
        <div className="bg-[linear-gradient(135deg,#2d0b45_0%,#5b197a_70%,#f97316_140%)] px-7 py-8 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
            DanceFlow Appointment
          </p>
          <h1 className="mt-3 text-3xl font-semibold">Confirm your appointment</h1>
        </div>

        <div className="p-7">
          <div
            className={`rounded-2xl border p-5 ${
              state === "confirmed"
                ? "border-cyan-200 bg-cyan-50 text-cyan-950"
                : state === "error"
                  ? "border-red-200 bg-red-50 text-red-950"
                  : "border-slate-200 bg-slate-50 text-slate-800"
            }`}
          >
            <p className="font-semibold">{message}</p>
          </div>

          {state === "ready" || state === "loading" ? (
            <button
              type="button"
              disabled={state === "loading"}
              onClick={confirm}
              className="mt-5 w-full rounded-2xl bg-cyan-600 px-5 py-3 font-semibold text-white hover:bg-cyan-700 disabled:opacity-60"
            >
              {state === "loading" ? "Confirming…" : "Confirm appointment"}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
