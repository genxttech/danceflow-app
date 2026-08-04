"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSettingsManageAccess } from "@/lib/auth/serverRoleGuard";

type ActionState = { error?: string };

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  return value === "true" || value === "on" || value === "1";
}

export async function updateStudioOperatingHoursAction(
  _previousState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  try {
    const { supabase, studioId } = await requireSettingsManageAccess();

    const rows = Array.from({ length: 7 }, (_, weekday) => {
      const isClosed = getBoolean(formData, `closed_${weekday}`);
      const opensAt = getString(formData, `opens_${weekday}`);
      const closesAt = getString(formData, `closes_${weekday}`);

      if (!isClosed) {
        if (!TIME_PATTERN.test(opensAt) || !TIME_PATTERN.test(closesAt)) {
          throw new Error("Each open day needs a valid opening and closing time.");
        }

        if (closesAt <= opensAt) {
          throw new Error("Closing time must be after opening time.");
        }
      }

      return {
        studio_id: studioId,
        weekday,
        is_closed: isClosed,
        opens_at: isClosed ? null : opensAt,
        closes_at: isClosed ? null : closesAt,
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from("studio_operating_hours")
      .upsert(rows, { onConflict: "studio_id,weekday" });

    if (error) {
      return { error: `Studio hours could not be saved: ${error.message}` };
    }

    revalidatePath("/app/settings/hours");
    revalidatePath("/app/schedule/calendar");
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Studio hours could not be saved.",
    };
  }

  redirect("/app/settings/hours?success=hours_saved");
}
