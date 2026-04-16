import { loginAction } from "../actions";

export default function LoginPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="mx-auto max-w-md rounded-2xl bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Log in</h1>
        <p className="mt-2 text-sm text-slate-600">
          Access your studio dashboard.
        </p>

        <form action={loginAction} className="mt-6 space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
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
              className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-slate-500"
            />
          </div>

          <button
            type="submit"
            className="w-full rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Log In
          </button>
        </form>

        <p className="mt-4 text-sm text-slate-600">
          Need an account?{" "}
          <a href="/signup" className="font-medium text-slate-900 underline">
            Create one
          </a>
        </p>
      </div>
    </main>
  );
}