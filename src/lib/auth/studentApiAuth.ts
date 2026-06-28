import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function getStudentApiUser(request: Request) {
  const authClient = await createClient();
  const {
    data: { user },
    error,
  } = await authClient.auth.getUser();

  if (user && !error) return user;

  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];

  if (!token) return null;

  const adminClient = createAdminClient();
  const {
    data: { user: bearerUser },
    error: bearerError,
  } = await adminClient.auth.getUser(token);

  if (bearerError || !bearerUser) return null;
  return bearerUser;
}
