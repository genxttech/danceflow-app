import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCommerceThumbnails } from "@/lib/commerce/thumbnail";

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

export default async function MarketplacePage() {
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
        status,
        release_at,
        mux_upload_status,
        mux_playback_id
      )
    `)
    .eq("active", true)
    .eq("published", true)
    .eq("marketplace_visible", true)
    .in("item_type", ["digital_video", "video_series"])
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Marketplace failed to load: ${error.message}`);
  }

  const rows = (data ?? []).filter((row: any) => {
    const studio = one(row.studios);
    const content = one(row.commerce_digital_content);
    return (
      ["active", "trialing"].includes(studio?.subscription_status ?? "") &&
      studio?.stripe_connect_charges_enabled === true &&
      content?.status === "published" &&
      (!content.release_at ||
        new Date(content.release_at).getTime() <= Date.now()) &&
      (row.item_type === "video_series" ||
        content.mux_upload_status === "ready")
    );
  });

  const thumbnails = await resolveCommerceThumbnails({
    supabase: admin,
    items: rows.map((row: any) => ({
      id: row.id,
      item_type: row.item_type,
      image_url: row.image_url,
      commerce_digital_content: one(row.commerce_digital_content),
    })),
  });

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 sm:px-6 lg:px-8">
      <section className="mx-auto max-w-7xl">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#6B21A8]">
          DanceFlow Marketplace
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
          Learn from DanceFlow studios
        </h1>
        <p className="mt-3 max-w-3xl text-base leading-7 text-slate-600">
          Browse secure videos and series created by dance professionals.
          Purchases are completed in the DanceFlow student app and remain
          available in Learn and Wallet.
        </p>

        {rows.length ? (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {rows.map((row: any) => {
              const studio = one(row.studios);
              const content = one(row.commerce_digital_content);
              const imageUrl = thumbnails.get(row.id)?.imageUrl ?? null;
              return (
                <Link
                  key={row.id}
                  href={`/marketplace/${row.id}`}
                  className="overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
                >
                  <div className="aspect-video bg-[linear-gradient(135deg,#ede9fe,#fdf2f8)]">
                    {imageUrl ? (
                      <img
                        src={imageUrl}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm font-semibold text-violet-700">
                        DanceFlow Digital Learning
                      </div>
                    )}
                  </div>
                  <div className="p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-violet-700">
                      {row.item_type === "video_series"
                        ? "Video series"
                        : "Digital video"}
                    </p>
                    <h2 className="mt-2 text-xl font-semibold text-slate-950">
                      {row.name}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {studio?.public_name?.trim() ||
                        studio?.name ||
                        "Dance studio"}
                    </p>
                    {row.description ? (
                      <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600">
                        {row.description}
                      </p>
                    ) : null}
                    <div className="mt-4 flex items-center justify-between gap-3">
                      <span className="font-semibold text-slate-950">
                        {money(row.price, String(row.currency ?? "USD").toUpperCase())}
                      </span>
                      <span className="text-sm font-semibold text-[#6B21A8]">
                        View details
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="mt-8 rounded-3xl border border-dashed border-slate-300 bg-white p-10 text-center text-slate-600">
            New studio-created videos and series are coming soon.
          </div>
        )}
      </section>
    </main>
  );
}
