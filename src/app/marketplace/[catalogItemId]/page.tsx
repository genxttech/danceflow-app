import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCommerceThumbnail } from "@/lib/commerce/thumbnail";

type Params = Promise<{ catalogItemId: string }>;

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

export default async function MarketplaceItemPage({
  params,
}: {
  params: Params;
}) {
  const { catalogItemId } = await params;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("commerce_catalog_items")
    .select(`
      id,
      studio_id,
      name,
      description,
      item_type,
      price,
      currency,
      image_url,
      active,
      published,
      marketplace_visible,
      studios:studio_id (
        name,
        public_name,
        subscription_status,
        stripe_connect_charges_enabled
      ),
      commerce_digital_content (
        instructor_name,
        skill_level,
        dance_style,
        duration_seconds,
        summary,
        status,
        release_at,
        mux_upload_status,
        mux_playback_id
      )
    `)
    .eq("id", catalogItemId)
    .maybeSingle();

  const studio = one((data as any)?.studios);
  const content = one((data as any)?.commerce_digital_content);
  const available =
    !error &&
    data?.active === true &&
    data?.published === true &&
    data?.marketplace_visible === true &&
    ["digital_video", "video_series"].includes(data?.item_type ?? "") &&
    ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
    studio?.stripe_connect_charges_enabled === true &&
    content?.status === "published" &&
    (!content.release_at ||
      new Date(content.release_at).getTime() <= Date.now()) &&
    (data?.item_type === "video_series" ||
      content?.mux_upload_status === "ready");

  if (!available || !data) notFound();

  const thumbnail = await resolveCommerceThumbnail({
    supabase: admin,
    item: {
      id: data.id,
      item_type: data.item_type,
      image_url: data.image_url,
      commerce_digital_content: content,
    },
  });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6 lg:px-8">
      <article className="mx-auto max-w-5xl overflow-hidden rounded-[36px] border border-slate-200 bg-white shadow-sm">
        <div className="aspect-video bg-[linear-gradient(135deg,#ede9fe,#fdf2f8)]">
          {thumbnail.imageUrl ? (
            <img
              src={thumbnail.imageUrl}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-lg font-semibold text-violet-700">
              DanceFlow Digital Learning
            </div>
          )}
        </div>
        <div className="p-6 md:p-8">
          <Link
            href="/marketplace"
            className="text-sm font-semibold text-[#6B21A8] hover:underline"
          >
            Back to Marketplace
          </Link>
          <p className="mt-6 text-xs font-bold uppercase tracking-[0.18em] text-violet-700">
            {data.item_type === "video_series"
              ? "Video series"
              : "Digital video"}
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
            {data.name}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {studio?.public_name?.trim() || studio?.name || "Dance studio"}
          </p>
          <p className="mt-5 max-w-3xl text-base leading-7 text-slate-700">
            {content?.summary || data.description || "Studio-created digital dance instruction."}
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-sm">
            {content?.instructor_name ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5">
                Instructor: {content.instructor_name}
              </span>
            ) : null}
            {content?.dance_style ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5">
                {content.dance_style}
              </span>
            ) : null}
            {content?.skill_level ? (
              <span className="rounded-full bg-slate-100 px-3 py-1.5 capitalize">
                {content.skill_level.replaceAll("_", " ")}
              </span>
            ) : null}
          </div>
          <div className="mt-8 flex flex-col gap-3 rounded-3xl bg-violet-50 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm text-slate-600">Price</p>
              <p className="mt-1 text-3xl font-semibold text-slate-950">
                {money(data.price, String(data.currency ?? "USD").toUpperCase())}
              </p>
            </div>
            <p className="max-w-md text-sm leading-6 text-slate-600">
              Open the DanceFlow student app to purchase securely. Your access
              will appear in Learn and Wallet after payment.
            </p>
          </div>
        </div>
      </article>
    </main>
  );
}
