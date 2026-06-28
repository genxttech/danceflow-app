import { redirect } from "next/navigation";

export default function ScheduleRequestsRedirectPage() {
  redirect("/app/schedule/self-service");
}
