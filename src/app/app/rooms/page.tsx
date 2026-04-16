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

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Rooms</h2>
          <p className="mt-2 text-slate-600">Manage studio rooms.</p>
        </div>

        <Link
          href="/app/rooms/new"
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          New Room
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Rooms</p>
          <p className="mt-2 text-3xl font-semibold">{typedRooms.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Inactive</p>
          <p className="mt-2 text-3xl font-semibold">{inactiveCount}</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-left text-slate-600">
              <th className="px-4 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Description</th>
              <th className="px-4 py-3 font-medium">Capacity</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {typedRooms.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No rooms yet.
                </td>
              </tr>
            ) : (
              typedRooms.map((room) => (
                <tr key={room.id} className="border-t">
                  <td className="px-4 py-3 font-medium text-slate-900">
                    <Link href={`/app/rooms/${room.id}`} className="hover:underline">
                      {room.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{room.description ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">{room.capacity ?? "—"}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {room.active ? "active" : "inactive"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/app/rooms/${room.id}`}
                        className="text-slate-900 underline"
                      >
                        View
                      </Link>
                      <Link
                        href={`/app/rooms/${room.id}/edit`}
                        className="text-slate-900 underline"
                      >
                        Edit
                      </Link>
                      {room.active ? (
                        <form action={deactivateRoomAction}>
                          <input type="hidden" name="roomId" value={room.id} />
                          <button type="submit" className="text-red-600 underline">
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
    </div>
  );
}