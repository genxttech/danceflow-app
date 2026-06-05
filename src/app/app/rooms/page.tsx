import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { deactivateRoomAction } from "./actions";
import { canManageRooms } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type RoomRow = {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  active: boolean;
  created_at: string;
};

function statusBadge(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

export default async function RoomsPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManageRooms(role)) {
    redirect("/app");
  }

  const { data: rooms, error } = await supabase
    .from("rooms")
    .select("id, name, description, capacity, active, created_at")
    .eq("studio_id", studioId)
    .order("name", { ascending: true });

  if (error) {
    throw new Error(`Failed to load rooms: ${error.message}`);
  }

  const typedRooms = (rooms ?? []) as RoomRow[];
  const activeCount = typedRooms.filter((room) => room.active).length;
  const inactiveCount = typedRooms.filter((room) => !room.active).length;
  const totalCapacity = typedRooms.reduce((sum, room) => sum + (room.capacity ?? 0), 0);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_24%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Studio Setup
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Rooms & Spaces
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Set up the rooms, dance floors, and rental spaces your studio uses for lessons,
                classes, practice time, and instructor rentals.
              </p>
            </div>

            <Link
              href="/app/rooms/new"
              className="inline-flex items-center justify-center rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[var(--brand-primary)] shadow-sm hover:bg-white/90"
            >
              New Room
            </Link>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Total spaces</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{typedRooms.length}</p>
              <p className="mt-2 text-sm text-slate-500">
                Rooms available for scheduling and operations.
              </p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Active spaces</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{activeCount}</p>
              <p className="mt-2 text-sm text-slate-500">
                Active rooms can be used in schedules and workflows.
              </p>
            </div>

            <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">Listed capacity</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{totalCapacity || "—"}</p>
              <p className="mt-2 text-sm text-slate-500">
                Optional capacity helps staff choose the right space.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Studio room list</h2>
            <p className="mt-1 text-sm leading-6 text-slate-500">
              Keep room names simple and recognizable so staff can schedule quickly.
            </p>
          </div>
          {inactiveCount > 0 ? (
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              {inactiveCount} inactive
            </span>
          ) : null}
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left text-slate-600">
                <th className="px-4 py-3 font-medium">Room</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">Description</th>
                <th className="px-4 py-3 font-medium">Capacity</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {typedRooms.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <div className="mx-auto max-w-md">
                      <h3 className="text-base font-semibold text-slate-950">
                        Add your first room or dance floor
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-slate-500">
                        Rooms help prevent scheduling conflicts and keep floor usage organized.
                      </p>
                      <Link
                        href="/app/rooms/new"
                        className="mt-4 inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                      >
                        Create Room
                      </Link>
                    </div>
                  </td>
                </tr>
              ) : (
                typedRooms.map((room) => (
                  <tr key={room.id} className="border-t border-slate-100 align-top">
                    <td className="px-4 py-4">
                      <Link
                        href={`/app/rooms/${room.id}`}
                        className="font-medium text-slate-950 hover:underline"
                      >
                        {room.name}
                      </Link>
                      <p className="mt-1 line-clamp-2 text-xs text-slate-500 md:hidden">
                        {room.description ?? "No description added."}
                      </p>
                    </td>
                    <td className="hidden px-4 py-4 text-slate-600 md:table-cell">
                      {room.description ?? "—"}
                    </td>
                    <td className="px-4 py-4 text-slate-600">{room.capacity ?? "—"}</td>
                    <td className="px-4 py-4">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${statusBadge(room.active)}`}
                      >
                        {room.active ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/app/rooms/${room.id}`}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          View
                        </Link>
                        <Link
                          href={`/app/rooms/${room.id}/edit`}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                        >
                          Edit
                        </Link>
                        {room.active ? (
                          <form action={deactivateRoomAction}>
                            <input type="hidden" name="roomId" value={room.id} />
                            <button
                              type="submit"
                              className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs font-medium text-rose-700 hover:bg-rose-50"
                            >
                              Deactivate
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
