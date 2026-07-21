import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Download,
  Film,
  Library,
  LockKeyhole,
  PlaySquare,
  Radio,
  Save,
  Trash2,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageCommerce } from "@/lib/auth/permissions";
import MuxVideoUploader from "./MuxVideoUploader";
import {
  addSeriesItemAction,
  removeSeriesItemAction,
  saveDigitalContentAction,
  setDigitalContentStatusAction,
} from "./actions";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ error?: string; success?: string }>;

type CatalogItem = {
  id: string;
  name: string;
  description: string | null;
  item_type: string;
  price: number | string;
  currency: string;
  active: boolean;
  published: boolean;
  marketplace_visible: boolean;
};

type DigitalContent = {
  id: string;
  content_kind: string;
  title: string;
  summary: string | null;
  skill_level: string | null;
  dance_style: string | null;
  instructor_name: string | null;
  duration_seconds: number | null;
  thumbnail_bucket: string | null;
  thumbnail_path: string | null;
  media_bucket: string | null;
  media_path: string | null;
  download_bucket: string | null;
  download_path: string | null;
  external_provider: string | null;
  external_asset_id: string | null;
  external_playback_id: string | null;
  mux_upload_id: string | null;
  mux_upload_status: string | null;
  mux_asset_id: string | null;
  mux_asset_status: string | null;
  mux_playback_id: string | null;
  mux_error_message: string | null;
  mux_aspect_ratio: string | null;
  status: string;
  release_at: string | null;
  published_at: string | null;
  archived_at: string | null;
};

type SeriesItem = {
  id: string;
  position: number;
  title_override: string | null;
  child_catalog_item_id: string;
  commerce_catalog_items:
    | {
        id: string;
        name: string;
        price: number | string;
        published: boolean;
      }
    | {
        id: string;
        name: string;
        price: number | string;
        published: boolean;
      }[]
    | null;
};

type VideoCandidate = {
  id: string;
  name: string;
  published: boolean;
};

function relation<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

function datetimeLocal(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function kindLabel(itemType: string) {
  if (itemType === "digital_video") return "Video";
  if (itemType === "video_series") return "Video series";
  return "Digital download";
}

function KindIcon({ itemType }: { itemType: string }) {
  if (itemType === "video_series") return <Library className="h-5 w-5" />;
  if (itemType === "digital_download") return <Download className="h-5 w-5" />;
  return <Film className="h-5 w-5" />;
}

export default async function DigitalContentPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const messages = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.isPlatformAdmin &&
    !canManageCommerce(context.studioRole)
  ) {
    redirect("/app");
  }

  const [
    { data: item, error: itemError },
    { data: content, error: contentError },
    { data: seriesRows, error: seriesError },
    { data: videoRows, error: videosError },
  ] = await Promise.all([
    supabase
      .from("commerce_catalog_items")
      .select(
        "id, name, description, item_type, price, currency, active, published, marketplace_visible",
      )
      .eq("id", id)
      .eq("studio_id", context.studioId)
      .maybeSingle(),
    supabase
      .from("commerce_digital_content")
      .select(
        "id, content_kind, title, summary, skill_level, dance_style, instructor_name, duration_seconds, thumbnail_bucket, thumbnail_path, media_bucket, media_path, download_bucket, download_path, external_provider, external_asset_id, external_playback_id, mux_upload_id, mux_upload_status, mux_asset_id, mux_asset_status, mux_playback_id, mux_error_message, mux_aspect_ratio, status, release_at, published_at, archived_at",
      )
      .eq("catalog_item_id", id)
      .eq("studio_id", context.studioId)
      .maybeSingle(),
    supabase
      .from("commerce_series_items")
      .select(
        "id, position, title_override, child_catalog_item_id, commerce_catalog_items!commerce_series_items_child_catalog_item_id_fkey(id, name, price, published)",
      )
      .eq("series_catalog_item_id", id)
      .eq("studio_id", context.studioId)
      .eq("active", true)
      .order("position", { ascending: true }),
    supabase
      .from("commerce_catalog_items")
      .select("id, name, published")
      .eq("studio_id", context.studioId)
      .eq("item_type", "digital_video")
      .eq("active", true)
      .order("name", { ascending: true }),
  ]);

  if (itemError) {
    throw new Error(`Catalog item failed to load: ${itemError.message}`);
  }

  if (!item) notFound();

  const catalogItem = item as CatalogItem;

  if (
    !["digital_video", "video_series", "digital_download"].includes(
      catalogItem.item_type,
    )
  ) {
    redirect(`/app/catalog/${catalogItem.id}`);
  }

  if (contentError) {
    throw new Error(`Digital content failed to load: ${contentError.message}`);
  }

  if (seriesError) {
    throw new Error(`Series items failed to load: ${seriesError.message}`);
  }

  if (videosError) {
    throw new Error(`Video library failed to load: ${videosError.message}`);
  }

  const digitalContent = content as DigitalContent | null;
  const seriesItems = (seriesRows ?? []) as SeriesItem[];
  const videoCandidates = (videoRows ?? []) as VideoCandidate[];
  const isVideo = catalogItem.item_type === "digital_video";
  const isSeries = catalogItem.item_type === "video_series";
  const isDownload = catalogItem.item_type === "digital_download";
  const contentStatus = digitalContent?.status ?? "draft";
  const mediaReady = isVideo
    ? digitalContent?.mux_upload_status === "ready" &&
      Boolean(digitalContent?.mux_playback_id)
    : isDownload
      ? Boolean(
          digitalContent?.download_bucket && digitalContent?.download_path,
        )
      : seriesItems.length > 0;

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <Link
          href="/app/catalog"
          className="inline-flex items-center gap-2 text-sm font-semibold text-white/80"
        >
          <ArrowLeft className="h-4 w-4" />
          Catalog
        </Link>

        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-white/75">
              <KindIcon itemType={catalogItem.item_type} />
              <span className="text-xs font-semibold uppercase tracking-[0.2em]">
                {kindLabel(catalogItem.item_type)}
              </span>
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              {digitalContent?.title || catalogItem.name}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/80">
              Add the lesson details and upload the video. DanceFlow sends
              the file directly to Mux, monitors processing, and prepares it
              for secure student playback.
            </p>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 text-sm">
            <p className="text-white/70">Catalog price</p>
            <p className="mt-1 text-2xl font-semibold">
              {money(catalogItem.price, catalogItem.currency)}
            </p>
            <p className="mt-1 capitalize text-white/70">
              {contentStatus.replaceAll("_", " ")}
            </p>
          </div>
        </div>
      </section>

      {messages.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {decodeURIComponent(messages.error)}
        </div>
      ) : null}

      {messages.success ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Digital content updated.
        </div>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          {
            title: "Content status",
            value: contentStatus.replaceAll("_", " "),
            icon: Radio,
          },
          {
            title: "Asset readiness",
            value: mediaReady ? "Ready" : "Needs setup",
            icon: LockKeyhole,
          },
          {
            title: "Marketplace",
            value: catalogItem.marketplace_visible ? "Visible" : "Hidden",
            icon: PlaySquare,
          },
          {
            title: isSeries ? "Series lessons" : "Duration",
            value: isSeries
              ? String(seriesItems.length)
              : digitalContent?.duration_seconds
                ? `${Math.round(digitalContent.duration_seconds / 60)} min`
                : "Not set",
            icon: BookOpen,
          },
        ].map((stat) => {
          const Icon = stat.icon;

          return (
            <div
              key={stat.title}
              className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <Icon className="h-5 w-5 text-[var(--brand-primary)]" />
              <p className="mt-4 text-sm text-slate-500">{stat.title}</p>
              <p className="mt-1 text-xl font-semibold capitalize text-slate-950">
                {stat.value}
              </p>
            </div>
          );
        })}
      </section>

      {isVideo ? (
        <MuxVideoUploader
          catalogItemId={catalogItem.id}
          muxStatus={digitalContent?.mux_upload_status ?? null}
          errorMessage={digitalContent?.mux_error_message ?? null}
        />
      ) : null}

      <form
        action={saveDigitalContentAction}
        className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <input type="hidden" name="catalogItemId" value={catalogItem.id} />

        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Save className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-950">
              Content details
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              These fields support catalog discovery, future Learn placement,
              and entitlement-aware playback.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-2 text-sm font-medium text-slate-700">
            Title
            <input
              name="title"
              required
              maxLength={160}
              defaultValue={digitalContent?.title ?? catalogItem.name}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>

          <label className="space-y-2 text-sm font-medium text-slate-700">
            Skill level
            <select
              name="skillLevel"
              defaultValue={digitalContent?.skill_level ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            >
              <option value="">Not specified</option>
              <option value="all_levels">All levels</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
              <option value="professional">Professional</option>
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-slate-700">
            Dance style
            <input
              name="danceStyle"
              maxLength={120}
              defaultValue={digitalContent?.dance_style ?? ""}
              placeholder="Country Two Step"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>

          <label className="space-y-2 text-sm font-medium text-slate-700">
            Instructor
            <input
              name="instructorName"
              maxLength={160}
              defaultValue={digitalContent?.instructor_name ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>

          {!isSeries ? (
            <label className="space-y-2 text-sm font-medium text-slate-700">
              Duration in seconds
              <input
                name="durationSeconds"
                type="number"
                min="0"
                max="86400"
                defaultValue={digitalContent?.duration_seconds ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
              />
            </label>
          ) : null}

          <label className="space-y-2 text-sm font-medium text-slate-700">
            Scheduled release
            <input
              name="releaseAt"
              type="datetime-local"
              defaultValue={datetimeLocal(digitalContent?.release_at ?? null)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
            />
          </label>
        </div>

        <label className="mt-4 block space-y-2 text-sm font-medium text-slate-700">
          Summary
          <textarea
            name="summary"
            rows={4}
            maxLength={3000}
            defaultValue={digitalContent?.summary ?? catalogItem.description ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>

        {isDownload ? (
          <details className="mt-6 rounded-3xl bg-slate-50 p-5">
            <summary className="cursor-pointer font-semibold text-slate-950">
              Advanced download storage
            </summary>
            <p className="mt-2 text-sm text-slate-600">
              Download uploads will receive the same guided experience in a
              later patch. These fields are retained only for existing advanced
              configurations.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Download bucket
                <input
                  name="downloadBucket"
                  maxLength={100}
                  defaultValue={digitalContent?.download_bucket ?? ""}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                />
              </label>
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Download object path
                <input
                  name="downloadPath"
                  maxLength={500}
                  defaultValue={digitalContent?.download_path ?? ""}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
                />
              </label>
            </div>
          </details>
        ) : null}

        {isVideo && digitalContent?.mux_asset_id ? (
          <details className="mt-6 rounded-3xl bg-slate-50 p-5">
            <summary className="cursor-pointer font-semibold text-slate-950">
              Advanced video details
            </summary>
            <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
              <p>
                <span className="font-semibold text-slate-800">Provider:</span>{" "}
                Mux
              </p>
              <p>
                <span className="font-semibold text-slate-800">Asset status:</span>{" "}
                {digitalContent.mux_asset_status || "Unknown"}
              </p>
              <p className="break-all">
                <span className="font-semibold text-slate-800">Asset ID:</span>{" "}
                {digitalContent.mux_asset_id}
              </p>
              <p className="break-all">
                <span className="font-semibold text-slate-800">Playback ID:</span>{" "}
                {digitalContent.mux_playback_id || "Pending"}
              </p>
            </div>
          </details>
        ) : null}

        <button className="mt-6 rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
          Save content details
        </button>
      </form>

      {isSeries ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <h2 className="text-xl font-semibold text-slate-950">
              Series lessons
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Add existing video products and control their sequence. The same
              video may belong to more than one series.
            </p>
          </div>

          <form
            action={addSeriesItemAction}
            className="mt-5 grid gap-4 rounded-2xl bg-slate-50 p-4 md:grid-cols-[1fr_120px_1fr_auto]"
          >
            <input type="hidden" name="catalogItemId" value={catalogItem.id} />
            <label className="space-y-2 text-sm font-medium text-slate-700">
              Video
              <select
                name="childCatalogItemId"
                required
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
              >
                <option value="">Choose video</option>
                {videoCandidates.map((video) => (
                  <option key={video.id} value={video.id}>
                    {video.name}
                    {video.published ? " · Published" : " · Draft"}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-2 text-sm font-medium text-slate-700">
              Position
              <input
                name="position"
                type="number"
                min="0"
                defaultValue={seriesItems.length + 1}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
              />
            </label>
            <label className="space-y-2 text-sm font-medium text-slate-700">
              Optional lesson title
              <input
                name="titleOverride"
                maxLength={160}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
              />
            </label>
            <button className="self-end rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
              Add
            </button>
          </form>

          <div className="mt-5 space-y-3">
            {seriesItems.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                No videos are in this series yet.
              </div>
            ) : (
              seriesItems.map((seriesItem) => {
                const child = relation(seriesItem.commerce_catalog_items);

                return (
                  <div
                    key={seriesItem.id}
                    className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex items-center gap-4">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--brand-primary-soft)] font-semibold text-[var(--brand-primary)]">
                        {seriesItem.position}
                      </span>
                      <div>
                        <p className="font-semibold text-slate-950">
                          {seriesItem.title_override || child?.name || "Video"}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {child?.published ? "Published video" : "Draft video"}
                        </p>
                      </div>
                    </div>
                    <form action={removeSeriesItemAction}>
                      <input
                        type="hidden"
                        name="catalogItemId"
                        value={catalogItem.id}
                      />
                      <input
                        type="hidden"
                        name="seriesLinkId"
                        value={seriesItem.id}
                      />
                      <button className="inline-flex items-center gap-2 rounded-xl border border-rose-200 px-3 py-2 text-sm font-semibold text-rose-700">
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </button>
                    </form>
                  </div>
                );
              })
            )}
          </div>
        </section>
      ) : null}

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-slate-950">
          Publishing controls
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Publishing makes the content eligible for future marketplace and Learn
          surfaces. It does not grant access or enable playback in this slice.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          <form action={setDigitalContentStatusAction}>
            <input type="hidden" name="catalogItemId" value={catalogItem.id} />
            <input type="hidden" name="status" value="published" />
            <input
              type="hidden"
              name="marketplaceVisible"
              value="true"
            />
            <button
              disabled={!digitalContent || !mediaReady}
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              Publish to marketplace
            </button>
          </form>

          <form action={setDigitalContentStatusAction}>
            <input type="hidden" name="catalogItemId" value={catalogItem.id} />
            <input type="hidden" name="status" value="published" />
            <input
              type="hidden"
              name="marketplaceVisible"
              value="false"
            />
            <button
              disabled={!digitalContent || !mediaReady}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50"
            >
              Publish privately
            </button>
          </form>

          <form action={setDigitalContentStatusAction}>
            <input type="hidden" name="catalogItemId" value={catalogItem.id} />
            <input type="hidden" name="status" value="draft" />
            <input
              type="hidden"
              name="marketplaceVisible"
              value="false"
            />
            <button className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700">
              Return to draft
            </button>
          </form>

          <form action={setDigitalContentStatusAction}>
            <input type="hidden" name="catalogItemId" value={catalogItem.id} />
            <input type="hidden" name="status" value="archived" />
            <input
              type="hidden"
              name="marketplaceVisible"
              value="false"
            />
            <button className="rounded-xl border border-rose-200 px-4 py-2.5 text-sm font-semibold text-rose-700">
              Archive
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
