"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  createInstructorCredentialAction,
  deleteInstructorCredentialAction,
  updateInstructorAction,
} from "../../actions";

const initialState = { error: "" };

type InstructorCredentialRecord = {
  id: string;
  credential_type: string;
  name: string;
  issuing_organization: string | null;
  credential_year: number | null;
  proof_url: string | null;
  notes: string | null;
  public_enabled: boolean;
  display_order: number;
  verification_status: string;
  review_note: string | null;
  submitted_at: string | null;
  reviewed_at: string | null;
};

type InstructorRecord = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  specialties: string | null;
  bio: string | null;
  active: boolean;
  public_profile_enabled?: boolean | null;
  public_photo_url?: string | null;
  public_title?: string | null;
  public_bio?: string | null;
  public_specialties?: string | null;
  years_experience?: number | null;
  display_order?: number | null;
  teaching_certifications?: string | null;
  competitive_titles?: string | null;
  credential_proof_url?: string | null;
  credentials_verification_status?: string | null;
  credentials_review_note?: string | null;
};

function RequiredMark() {
  return <span className="ml-1 text-red-600">*</span>;
}

function credentialTypeLabel(value: string) {
  if (value === "title") return "Title";
  if (value === "achievement") return "Achievement";
  return "Certification";
}

function credentialStatusClass(value: string) {
  if (value === "verified") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (value === "rejected") {
    return "bg-red-50 text-red-700 ring-red-200";
  }
  return "bg-amber-50 text-amber-700 ring-amber-200";
}

export default function InstructorEditForm({
  instructor,
  credentials,
}: {
  instructor: InstructorRecord;
  credentials: InstructorCredentialRecord[];
}) {
  const [state, formAction, pending] = useActionState(
    updateInstructorAction,
    initialState,
  );

  const instructorName =
    `${instructor.first_name} ${instructor.last_name}`.trim();

  return (
    <div className="max-w-5xl space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-sm">
        <div className="p-6 text-white md:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">
                DanceFlow Instructor Setup
              </p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
                Edit {instructorName || "Instructor"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Keep instructor details accurate so staff can schedule lessons,
                assign classes, manage floor rentals, and support instructor
                workflows without extra clicks.
              </p>
            </div>

            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href={`/app/instructors/${instructor.id}`}
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-100"
              >
                View Profile
              </Link>
              <Link
                href="/app/instructors"
                className="rounded-2xl border border-white/25 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
              >
                Back to Instructors
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">
              Instructor Details
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Profile information
            </h2>
          </div>
          <p className="max-w-xl text-sm text-slate-600">
            Fields marked with{" "}
            <span className="font-semibold text-red-600">*</span> are required.
            Use specialties to describe what this instructor teaches or handles
            most often.
          </p>
        </div>

        <form action={formAction} encType="multipart/form-data" className="mt-6 space-y-6">
          <input type="hidden" name="instructorId" value={instructor.id} />

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="firstName"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                First Name <RequiredMark />
              </label>
              <input
                id="firstName"
                name="firstName"
                defaultValue={instructor.first_name}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>

            <div>
              <label
                htmlFor="lastName"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Last Name <RequiredMark />
              </label>
              <input
                id="lastName"
                name="lastName"
                defaultValue={instructor.last_name}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={instructor.email ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>

            <div>
              <label
                htmlFor="phone"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                defaultValue={instructor.phone ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="specialties"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Internal Specialties
            </label>
            <input
              id="specialties"
              name="specialties"
              defaultValue={instructor.specialties ?? ""}
              placeholder="Example: Two Step, Ballroom, coaching, floor rentals"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            />
            <p className="mt-2 text-sm text-slate-500">
              Add practical teaching focus areas so staff can match the right
              instructor to the right lesson or class.
            </p>
          </div>

          <div>
            <label
              htmlFor="bio"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Internal Bio / Notes
            </label>
            <textarea
              id="bio"
              name="bio"
              rows={5}
              defaultValue={instructor.bio ?? ""}
              placeholder="Add a short instructor bio, teaching background, or notes staff should know."
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            />
          </div>

          <details
            className="rounded-3xl border border-orange-100 bg-gradient-to-br from-orange-50 via-white to-fuchsia-50 p-5 shadow-sm"
            open={Boolean(instructor.public_profile_enabled)}
          >
            <summary className="cursor-pointer list-none">
              <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.18em] text-orange-700">
                    Public Staff Profile
                  </p>
                  <h3 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
                    Show this instructor on the public studio page
                  </h3>
                </div>
                <span className="rounded-full border border-orange-200 bg-white px-3 py-1 text-xs font-semibold text-orange-700">
                  Optional
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                These fields power the Staff tab on the studio public page. Keep
                it short, friendly, and written for prospective students.
              </p>
            </summary>

            <div className="mt-5 space-y-5 border-t border-orange-100 pt-5">
              <label className="flex items-start gap-3 rounded-2xl border border-orange-100 bg-white/80 p-4 text-sm text-slate-700 shadow-sm">
                <input
                  type="checkbox"
                  name="publicProfileEnabled"
                  value="true"
                  defaultChecked={Boolean(instructor.public_profile_enabled)}
                  className="mt-1 h-4 w-4 rounded border-slate-300 text-orange-600 focus:ring-orange-500"
                />
                <span>
                  <span className="block font-semibold text-slate-900">
                    Show this instructor on the public studio page
                  </span>
                  <span className="mt-1 block text-slate-500">
                    Leave unchecked for internal-only instructors or staff who
                    should not appear publicly.
                  </span>
                </span>
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label
                    htmlFor="publicTitle"
                    className="mb-1 block text-sm font-semibold text-slate-800"
                  >
                    Public Title / Role
                  </label>
                  <input
                    id="publicTitle"
                    name="publicTitle"
                    defaultValue={instructor.public_title ?? ""}
                    placeholder="Example: Lead Instructor, Country Coach"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="instructorPhoto"
                    className="mb-1 block text-sm font-semibold text-slate-800"
                  >
                    Staff photo / headshot
                  </label>
                  <input
                    id="instructorPhoto"
                    name="instructorPhoto"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm file:mr-4 file:rounded-full file:border-0 file:bg-orange-50 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-orange-700"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    JPG, PNG, or WebP up to 5 MB. Choose an existing photo or take a new one, depending on your device.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="publicPhotoUrl"
                    className="mb-1 block text-sm font-semibold text-slate-800"
                  >
                    Photo URL fallback
                  </label>
                  <input
                    id="publicPhotoUrl"
                    name="publicPhotoUrl"
                    type="url"
                    defaultValue={instructor.public_photo_url ?? ""}
                    placeholder="https://..."
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="publicSpecialties"
                  className="mb-1 block text-sm font-semibold text-slate-800"
                >
                  Public Specialties
                </label>
                <input
                  id="publicSpecialties"
                  name="publicSpecialties"
                  defaultValue={instructor.public_specialties ?? ""}
                  placeholder="Example: Country Two Step, West Coast Swing, wedding dance"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                />
              </div>

              <div className="rounded-2xl border border-amber-100 bg-amber-50/70 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-700">
                      Credentials for Verification
                    </p>
                    <h4 className="mt-1 font-semibold text-slate-950">
                      Certifications, titles, and achievements
                    </h4>
                    <p className="mt-1 text-sm leading-6 text-slate-600">
                      Add each credential separately so DanceFlow can verify each certification or title against its own proof.
                      Only verified public credentials appear on the studio Staff section.
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-amber-700 ring-1 ring-amber-200">
                    {credentials.length} item{credentials.length === 1 ? "" : "s"}
                  </span>
                </div>

                {credentials.length ? (
                  <div className="mt-4 space-y-3">
                    {credentials.map((credential) => (
                      <div
                        key={credential.id}
                        className="rounded-2xl border border-amber-100 bg-white p-4 shadow-sm"
                      >
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
                                {credentialTypeLabel(credential.credential_type)}
                              </span>
                              <span
                                className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${credentialStatusClass(
                                  credential.verification_status,
                                )}`}
                              >
                                {credential.verification_status}
                              </span>
                              {credential.public_enabled ? (
                                <span className="rounded-full bg-violet-50 px-2.5 py-1 text-xs font-semibold text-violet-700 ring-1 ring-violet-100">
                                  Public when verified
                                </span>
                              ) : (
                                <span className="rounded-full bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
                                  Internal only
                                </span>
                              )}
                            </div>
                            <p className="mt-2 font-semibold text-slate-950">
                              {credential.name}
                            </p>
                            <p className="mt-1 text-sm text-slate-600">
                              {[credential.issuing_organization, credential.credential_year]
                                .filter(Boolean)
                                .join(" · ") || "No issuer/year listed"}
                            </p>
                            {credential.proof_url ? (
                              <a
                                href={credential.proof_url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-flex text-sm font-semibold text-amber-700 hover:text-amber-800"
                              >
                                View proof / reference
                              </a>
                            ) : null}
                            {credential.review_note ? (
                              <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                                Review note: {credential.review_note}
                              </p>
                            ) : null}
                          </div>

                          <button
                            type="submit"
                            name="credentialId"
                            value={credential.id}
                            formAction={deleteInstructorCredentialAction}
                            className="rounded-xl border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-amber-200 bg-white/70 p-4 text-sm text-slate-600">
                    No credentials have been added yet. Add each certification, title, or achievement as its own item.
                  </div>
                )}

                <div className="mt-5 rounded-2xl border border-amber-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-950">
                    Add a credential for verification
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    Use one form per certification, title, or achievement so the platform can verify each item individually.
                  </p>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <div>
                      <label
                        htmlFor="credentialType"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Credential Type
                      </label>
                      <select
                        id="credentialType"
                        name="credentialType"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      >
                        <option value="certification">Certification</option>
                        <option value="title">Title</option>
                        <option value="achievement">Achievement</option>
                      </select>
                    </div>

                    <div>
                      <label
                        htmlFor="credentialName"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Credential Name
                      </label>
                      <input
                        id="credentialName"
                        name="credentialName"
                        placeholder="Example: DVIDA Certified Instructor"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="issuingOrganization"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Issuing Organization / Event
                      </label>
                      <input
                        id="issuingOrganization"
                        name="issuingOrganization"
                        placeholder="Example: UCWDC, DVIDA, NDCA"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="credentialYear"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Year
                      </label>
                      <input
                        id="credentialYear"
                        name="credentialYear"
                        type="number"
                        min="1900"
                        max="2100"
                        placeholder="2025"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>

                    <div className="md:col-span-2">
                      <label
                        htmlFor="proofUrl"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Proof / Reference URL
                      </label>
                      <input
                        id="proofUrl"
                        name="proofUrl"
                        type="url"
                        placeholder="Link to certificate, results page, directory listing, or proof"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>

                    <div>
                      <label
                        htmlFor="credentialDisplayOrder"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Display Order
                      </label>
                      <input
                        id="credentialDisplayOrder"
                        name="credentialDisplayOrder"
                        type="number"
                        step="1"
                        defaultValue="0"
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>

                    <label className="flex items-center gap-3 rounded-xl border border-amber-100 bg-amber-50/70 px-3 py-2 text-sm font-semibold text-slate-700">
                      <input
                        type="checkbox"
                        name="credentialPublicEnabled"
                        defaultChecked
                        className="h-4 w-4 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                      Show publicly after verification
                    </label>

                    <div className="md:col-span-2">
                      <label
                        htmlFor="credentialNotes"
                        className="mb-1 block text-sm font-semibold text-slate-800"
                      >
                        Notes
                      </label>
                      <textarea
                        id="credentialNotes"
                        name="credentialNotes"
                        rows={2}
                        placeholder="Optional context for the platform review team."
                        className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-100"
                      />
                    </div>
                  </div>

                  <button
                    type="submit"
                    formAction={createInstructorCredentialAction}
                    className="mt-4 rounded-xl bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700"
                  >
                    Add Credential for Review
                  </button>
                </div>
              </div>

              <div>
                <label
                  htmlFor="publicBio"
                  className="mb-1 block text-sm font-semibold text-slate-800"
                >
                  Public Bio
                </label>
                <textarea
                  id="publicBio"
                  name="publicBio"
                  rows={4}
                  defaultValue={instructor.public_bio ?? ""}
                  placeholder="Write a short student-facing bio. Focus on teaching style, dance background, and who this instructor helps."
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label
                    htmlFor="yearsExperience"
                    className="mb-1 block text-sm font-semibold text-slate-800"
                  >
                    Years Experience
                  </label>
                  <input
                    id="yearsExperience"
                    name="yearsExperience"
                    type="number"
                    min="0"
                    step="1"
                    defaultValue={instructor.years_experience ?? ""}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="displayOrder"
                    className="mb-1 block text-sm font-semibold text-slate-800"
                  >
                    Display Order
                  </label>
                  <input
                    id="displayOrder"
                    name="displayOrder"
                    type="number"
                    step="1"
                    defaultValue={instructor.display_order ?? 0}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-orange-500 focus:ring-2 focus:ring-orange-100"
                  />
                  <p className="mt-2 text-xs text-slate-500">
                    Lower numbers appear first in the Staff tab.
                  </p>
                </div>
              </div>
            </div>
          </details>

          <div>
            <label
              htmlFor="active"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Status <RequiredMark />
            </label>
            <select
              id="active"
              name="active"
              defaultValue={instructor.active ? "true" : "false"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            >
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
            <p className="mt-2 text-sm text-slate-500">
              Set inactive when this instructor should no longer appear in
              active scheduling workflows.
            </p>
          </div>

          {state?.error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {state.error}
            </div>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-6 sm:flex-row">
            <button
              type="submit"
              disabled={pending}
              className="rounded-2xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Saving..." : "Save Changes"}
            </button>

            <Link
              href={`/app/instructors/${instructor.id}`}
              className="rounded-2xl border border-slate-200 px-5 py-2.5 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}

