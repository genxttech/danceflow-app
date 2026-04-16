import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import RoomEditForm from "./RoomEditForm";

type RoomRow = {
  id: string;
  name: string;
  capacity: number | null;
  active: boolean;
  description?: string | null;
};

export default async function EditRoomPage({
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

  return <RoomEditForm room={room as RoomRow} />;
}