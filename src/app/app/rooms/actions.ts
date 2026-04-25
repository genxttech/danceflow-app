"use server";

import { redirect } from "next/navigation";
import { requireRoomManageAccess } from "@/lib/auth/serverRoleGuard";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function createRoomAction(
  prevState: { error: string },
  formData: FormData,
) {
  try {
    const { supabase, studioId, user } = await requireRoomManageAccess();

    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const capacityRaw = getString(formData, "capacity");

    if (!name) {
      return { error: "Room name is required." };
    }

    const capacity =
      capacityRaw === "" ? null : Number.parseInt(capacityRaw, 10);

    if (
      capacityRaw !== "" &&
      (capacity === null || Number.isNaN(capacity) || capacity < 0)
    ) {
      return { error: "Capacity must be 0 or greater." };
    }

    const { error } = await supabase.from("rooms").insert({
      studio_id: studioId,
      name,
      description: description || null,
      capacity,
      active: true,
      });

    if (error) {
      return { error: `Room creation failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/rooms");
}

export async function updateRoomAction(
  prevState: { error: string },
  formData: FormData,
) {
  try {
    const { supabase, studioId } = await requireRoomManageAccess();

    const roomId = getString(formData, "roomId");
    const name = getString(formData, "name");
    const description = getString(formData, "description");
    const capacityRaw = getString(formData, "capacity");
    const active = getString(formData, "active");

    if (!roomId) {
      return { error: "Missing room ID." };
    }

    if (!name) {
      return { error: "Room name is required." };
    }

    const capacity =
      capacityRaw === "" ? null : Number.parseInt(capacityRaw, 10);

    if (
      capacityRaw !== "" &&
      (capacity === null || Number.isNaN(capacity) || capacity < 0)
    ) {
      return { error: "Capacity must be 0 or greater." };
    }

    const { error } = await supabase
      .from("rooms")
      .update({
        name,
        description: description || null,
        capacity,
        active: active === "true",
      })
      .eq("id", roomId)
      .eq("studio_id", studioId);

    if (error) {
      return { error: `Room update failed: ${error.message}` };
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Something went wrong.",
    };
  }

  redirect("/app/rooms");
}

export async function deactivateRoomAction(formData: FormData) {
  const { supabase, studioId } = await requireRoomManageAccess();

  const roomId = getString(formData, "roomId");

  if (!roomId) {
    throw new Error("Missing room ID.");
  }

  const { error } = await supabase
    .from("rooms")
    .update({ active: false })
    .eq("id", roomId)
    .eq("studio_id", studioId);

  if (error) {
    throw new Error(`Deactivate room failed: ${error.message}`);
  }

  redirect("/app/rooms");
}