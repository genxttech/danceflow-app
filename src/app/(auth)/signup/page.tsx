import Link from "next/link";
import { signupAction } from "../actions";

export default function SignupPage() {
  async function submitSignup(formData: FormData) {
    "use server";
    await signupAction(formData);
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-8 shadow-sm">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Create your DanceFlow account
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Start with a free account. You can explore studios and events now,
            then add a studio or organizer workspace after signup.
          </p>
        </div>

        <form action={submitSignup} className="mt-6 space-y-4">
          <div>
            <label htmlFor="fullName" className="mb-1 block text-sm font-medium">
              Full Name
            </label>
            <input
              id="fullName"
              name="fullName"
              type="text"
              required
              autoComplete="name"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium">
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
            />
          </div>

          <div>
            <label
              htmlFor="signupIntent"
              className="mb-1 block text-sm font-medium"
            >
              I plan to use DanceFlow for
            </label>
            <select
              id="signupIntent"
              name="signupIntent"
              defaultValue="public"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
            >
              <option value="public">Exploring studios and events</option>
              <option value="studio">Running a studio</option>
              <option value="organizer">Organizing events</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">
              This just helps route you after signup. It does not create a paid
              workspace yet.
            </p>
          </div>

          <button
            type="submit"
            className="w-full rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Create Free Account
          </button>
        </form>

        <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-medium text-slate-900">What happens next</p>
          <ul className="mt-2 space-y-1 text-sm text-slate-600">
            <li>• Public members can favorite studios and events.</li>
            <li>• Studio owners can choose a plan and start a trial.</li>
            <li>• Organizers can review event pricing and launch their workspace.</li>
          </ul>
        </div>

        <p className="mt-4 text-sm text-slate-600">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-slate-900 underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
