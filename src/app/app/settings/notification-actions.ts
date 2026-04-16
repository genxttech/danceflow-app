"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type NotificationSettingsActionState = {
  error: string;
  success: string;
};

type StudioNotificationSettingsRow = {
  public_intro_booking_enabled: boolean;
  follow_up_overdue_enabled: boolean;
  package_low_balance_enabled: boolean;
  package_depleted_enabled: boolean;
};

function notificationTypesToDisable(
  previous: StudioNotificationSettingsRow,
  next: StudioNotificationSettingsRow
) {
  const disabledTypes: string[] = [];

  if (previous.public_intro_booking_enabled && !next.public_intro_booking_enabled) {
    disabledTypes.push("public_intro_booking");
  }

  if (previous.follow_up_overdue_enabled && !next.follow_up_overdue_enabled) {
    disabledTypes.push("follow_up_overdue");
  }

  if (previous.package_low_balance_enabled && !next.package_low_balance_enabled) {
    disabledTypes.push("package_low_balance");
  }

  if (previous.package_depleted_enabled && !next.package_depleted_enabled) {
    disabledTypes.push("package_depleted");
  }

  return disabledTypes;
}

export async function updateStudioNotificationSettingsAction(
  _prevState: NotificationSettingsActionState,
  formData: FormData
): Promise<NotificationSettingsActionState> {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in.", success: "" };
  }

  const { data: roleRow, error: roleError } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (roleError || !roleRow) {
    return { error: "Studio access not found.", success: "" };
  }

  const studioId = roleRow.studio_id;

  const { data: existingSettings, error: existingSettingsError } = await supabase
    .from("studio_notification_settings")
    .select(`
      public_intro_booking_enabled,
      follow_up_overdue_enabled,
      package_low_balance_enabled,
      package_depleted_enabled
    `)
    .eq("studio_id", studioId)
    .maybeSingle();

  if (existingSettingsError) {
    return {
      error: `Failed to load current notification settings: ${existingSettingsError.message}`,
      success: "",
    };
  }

  const previousSettings: StudioNotificationSettingsRow = existingSettings ?? {
    public_intro_booking_enabled: true,
    follow_up_overdue_enabled: true,
    package_low_balance_enabled: true,
    package_depleted_enabled: true,
  };

  const nextSettings: StudioNotificationSettingsRow = {
    public_intro_booking_enabled:
      formData.get("public_intro_booking_enabled") === "on",
    follow_up_overdue_enabled:
      formData.get("follow_up_overdue_enabled") === "on",
    package_low_balance_enabled:
      formData.get("package_low_balance_enabled") === "on",
    package_depleted_enabled:
      formData.get("package_depleted_enabled") === "on",
  };

  const { error: saveError } = await supabase
    .from("studio_notification_settings")
    .upsert(
      {
        studio_id: studioId,
        ...nextSettings,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "studio_id" }
    );

  if (saveError) {
    return {
      error: `Failed to save notification settings: ${saveError.message}`,
      success: "",
    };
  }

  const disabledTypes = notificationTypesToDisable(previousSettings, nextSettings);

  if (disabledTypes.length > 0) {
    const { error: markReadError } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("studio_id", studioId)
      .in("type", disabledTypes)
      .is("read_at", null);

    if (markReadError) {
      return {
        error: `Settings were saved, but existing notifications could not be updated: ${markReadError.message}`,
        success: "",
      };
    }
  }

  revalidatePath("/app/settings");
  revalidatePath("/app");
  revalidatePath("/app/notifications");

  return {
    error: "",
    success:
      disabledTypes.length > 0
        ? "Notification settings updated. Existing unread notifications for disabled types were marked read."
        : "Notification settings updated.",
  };
}