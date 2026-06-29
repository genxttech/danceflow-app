import { InstructorAvailabilityEditor } from "./InstructorAvailabilityEditor";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ success?: string; error?: string }>;

export default async function InstructorAvailabilityPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams?: SearchParams;
}) {
  return (
    <InstructorAvailabilityEditor
      params={params}
      searchParams={searchParams}
      mode="manage"
    />
  );
}
