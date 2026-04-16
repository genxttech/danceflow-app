import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type RoomRow = {
  id: string;
  name: string;
  capacity: number | null;
  active: boolean;
  description?: string | null;
};

export default async function RoomDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const { data: room, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (error || !room) {
    notFound();
  }

  const typedRoom = room as RoomRow;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">{typedRoom.name}</h2>
          <p className="mt-2 text-slate-600">Room detail</p>
        </div>

        <div className="flex gap-3">
          <Link
            href={`/app/rooms/${typedRoom.id}/edit`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Edit Room
          </Link>
          <Link
            href="/app/rooms"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Rooms
          </Link>
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Name</p>
          <p className="mt-1 font-medium">{typedRoom.name}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Capacity</p>
          <p className="mt-1 font-medium">{typedRoom.capacity ?? "—"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <p className="mt-1 font-medium">
            {typedRoom.active ? "active" : "inactive"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Description</p>
          <p className="mt-1 font-medium">{typedRoom.description ?? "—"}</p>
        </div>
      </div>
    </div>
  );
}