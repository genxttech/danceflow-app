import { getCurrentUserStudioContext } from "@/lib/auth/serverRoleGuard";
import { canConfigureStudentIntake, isStudentIntakeConfigAvailable } from "./access";

export class IntakeAccessError extends Error {
  constructor(public readonly reason: "role" | "unavailable") {
    super(reason === "role" ? "Only the studio owner or an admin can change Student Intake." : "Student Intake is not available for this studio.");
    this.name = "IntakeAccessError";
  }
}

/**
 * Server-side gate for every Student Intake configuration read and write. The studio id always comes from the
 * signed-in user's studio context, never from request input. The database re-checks the role on every RPC.
 */
export async function requireStudentIntakeConfigure() {
  const ctx = await getCurrentUserStudioContext();
  if (!canConfigureStudentIntake(ctx.studioRole)) throw new IntakeAccessError("role");
  if (!isStudentIntakeConfigAvailable(ctx.studioId)) throw new IntakeAccessError("unavailable");
  return ctx;
}
