"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createAppointmentAction } from "../actions";

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type LinkedPartnerOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type ClientPackageItem = {
  id: string;
  item_type: "lesson" | "group_class" | "event" | "other";
  quantity: number;
  remaining_quantity: number | null;
  price_per_item: number;
};

type ClientPackageOption = {
  id: string;
  name_snapshot: string;
  status: string;
  expiration_date: string | null;
  client_package_items: ClientPackageItem[];
};

type MembershipBenefitOption = {
  benefit_type: string;
  applies_to: string | null;
  quantity_included: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
};

type ClientMembershipOption = {
  id: string;
  name_snapshot: string;
  status: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  current_period_start: string | null;
  current_period_end: string | null;
  membership_plan_benefits: MembershipBenefitOption[];
};

type AppointmentCreateFormProps = {
  instructors: InstructorOption[];
  rooms: RoomOption[];
  clients: ClientOption[];
  clientPackagesByClientId: Record<string, ClientPackageOption[]>;
  clientMembershipsByClientId: Record<string, ClientMembershipOption[]>;
  linkedPartnersByClientId: Record<string, LinkedPartnerOption[]>;
};

type FormState = {
  error?: string;
};

type FloorRentalSlot = {
  date: string;
  startTime: string;
  endTime: string;
};

const initialState: FormState = {};

function appointmentTypeLabel(value: string) {
  switch (value) {
    case "private_lesson":
      return "Private Lesson";
    case "group_class":
      return "Group Class";
    case "intro_lesson":
      return "Intro Lesson";
    case "coaching":
      return "Coaching";
    case "practice_party":
      return "Practice Party";
    case "event":
      return "Event";
    case "floor_space_rental":
      return "Floor Space Rental";
    default:
      return "Appointment";
  }
}

function packageHealthLabel(
  health: "healthy" | "low" | "depleted" | "expired" | "inactive"
) {
  switch (health) {
    case "healthy":
      return "Healthy";
    case "low":
      return "Low Remaining";
    case "depleted":
      return "Depleted";
    case "expired":
      return "Expired";
    case "inactive":
      return "Inactive";
    default:
      return "Unknown";
  }
}

function packageHealthClass(
  health: "healthy" | "low" | "depleted" | "expired" | "inactive"
) {
  switch (health) {
    case "healthy":
      return "bg-green-50 text-green-700";
    case "low":
      return "bg-amber-50 text-amber-700";
    case "depleted":
      return "bg-red-50 text-red-700";
    case "expired":
      return "bg-red-50 text-red-700";
    case "inactive":
      return "bg-slate-100 text-slate-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

function packageWarningMessage(
  health: "healthy" | "low" | "depleted" | "expired" | "inactive"
) {
  switch (health) {
    case "low":
      return "This package is running low. Review remaining lessons before saving.";
    case "depleted":
      return "This package has no remaining quantity for the selected appointment type.";
    case "expired":
      return "This package is expired and should not be used for new appointments.";
    case "inactive":
      return "This package is inactive and should not be linked.";
    default:
      return "";
  }
}

function summarizeClientPackageItems(items: ClientPackageItem[]) {
  if (!items.length) return "No package items configured.";

  return items
    .map((item) => {
      const remaining =
        item.remaining_quantity == null ? "Unlimited" : `${item.remaining_quantity} remaining`;
      return `${appointmentTypeLabel(item.item_type)} — ${remaining}`;
    })
    .join(" • ");
}

function formatShortDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "—";

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function billingIntervalLabel(value: string) {
  switch (value) {
    case "monthly":
      return "Month";
    case "quarterly":
      return "Quarter";
    case "yearly":
      return "Year";
    default:
      return value || "Billing period";
  }
}

function benefitTypeLabel(value: string) {
  switch (value) {
    case "included_private_lessons":
      return "Included Private Lessons";
    case "included_group_classes":
      return "Included Group Classes";
    case "discount_private_lessons_percent":
      return "Private Lesson % Discount";
    case "discount_private_lessons_fixed":
      return "Private Lesson Fixed Discount";
    case "discount_group_classes_percent":
      return "Group Class % Discount";
    case "discount_group_classes_fixed":
      return "Group Class Fixed Discount";
    case "discount_floor_rental_percent":
      return "Floor Rental % Discount";
    case "discount_floor_rental_fixed":
      return "Floor Rental Fixed Discount";
    default:
      return value;
  }
}

function doesBenefitApplyToAppointmentType(
  benefit: MembershipBenefitOption,
  appointmentType: string
) {
  const appliesTo = benefit.applies_to?.trim();

  if (!appliesTo || appliesTo === "all") {
    return true;
  }

  return appliesTo === appointmentType;
}

function summarizeBenefit(benefit: MembershipBenefitOption) {
  switch (benefit.benefit_type) {
    case "included_private_lessons":
    case "included_group_classes":
      return `${benefit.quantity_included ?? 0} included`;
    case "discount_private_lessons_percent":
    case "discount_group_classes_percent":
    case "discount_floor_rental_percent":
      return `${benefit.discount_percent ?? 0}% discount`;
    case "discount_private_lessons_fixed":
    case "discount_group_classes_fixed":
    case "discount_floor_rental_fixed":
      return `${formatCurrency(benefit.discount_amount ?? 0)} off`;
    default:
      return "Configured";
  }
}

function packageSupportsAppointmentType(
  appointmentType: string,
  clientPackage: ClientPackageOption | null
) {
  if (!clientPackage) return false;

  return clientPackage.client_package_items.some(
    (item) => item.item_type === appointmentType || item.item_type === "other"
  );
}

function computePackageHealth(
  appointmentType: string,
  clientPackage: ClientPackageOption | null
): "healthy" | "low" | "depleted" | "expired" | "inactive" {
  if (!clientPackage) return "inactive";

  if (clientPackage.status !== "active") {
    return "inactive";
  }

  if (clientPackage.expiration_date) {
    const today = new Date();
    const expiration = new Date(`${clientPackage.expiration_date}T23:59:59`);
    if (expiration.getTime() < today.getTime()) {
      return "expired";
    }
  }

  const relevantItems = clientPackage.client_package_items.filter(
    (item) => item.item_type === appointmentType || item.item_type === "other"
  );

  if (!relevantItems.length) {
    return "depleted";
  }

  const finiteItems = relevantItems.filter((item) => item.remaining_quantity != null);

  if (!finiteItems.length) {
    return "healthy";
  }

  const totalRemaining = finiteItems.reduce(
    (sum, item) => sum + (item.remaining_quantity ?? 0),
    0
  );

  if (totalRemaining <= 0) {
    return "depleted";
  }

  if (totalRemaining <= 2) {
    return "low";
  }

  return "healthy";
}

function paymentStatusLabel(value: string) {
  switch (value) {
    case "unpaid":
      return "Unpaid";
    case "partial":
      return "Partially Paid";
    case "paid":
      return "Paid";
    case "waived":
      return "Waived";
    default:
      return "Unpaid";
  }
}

export default function AppointmentCreateForm({
  instructors,
  rooms,
  clients,
  clientPackagesByClientId,
  clientMembershipsByClientId,
  linkedPartnersByClientId,
}: AppointmentCreateFormProps) {
  const [state, formAction, pending] = useActionState(
    createAppointmentAction,
    initialState
  );

  const [appointmentType, setAppointmentType] = useState("private_lesson");
  const [clientId, setClientId] = useState("");
  const [partnerClientId, setPartnerClientId] = useState("");
  const [linkedPackageId, setLinkedPackageId] = useState("");
  const [overrideRoomConflict, setOverrideRoomConflict] = useState(false);
  const [priceAmount, setPriceAmount] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("unpaid");
  const [slotDraft, setSlotDraft] = useState<FloorRentalSlot>({
    date: "",
    startTime: "",
    endTime: "",
  });
  const [floorRentalSlots, setFloorRentalSlots] = useState<FloorRentalSlot[]>([]);

  const selectedPackages = useMemo(() => {
  if (!clientId) return [];
  return clientPackagesByClientId?.[clientId] ?? [];
}, [clientId, clientPackagesByClientId]);

  const selectedMembership = useMemo(() => {
  if (!clientId) return null;

  const memberships = clientMembershipsByClientId?.[clientId] ?? [];
  return memberships.find((membership) => membership.status === "active") ?? null;
}, [clientId, clientMembershipsByClientId]);

  const linkedPartners = useMemo(
    () => linkedPartnersByClientId[clientId] ?? [],
    [clientId, linkedPartnersByClientId]
  );

  const selectedPackage =
    selectedPackages.find((clientPackage) => clientPackage.id === linkedPackageId) ?? null;

  const packageHealth = useMemo(
    () => computePackageHealth(appointmentType, selectedPackage),
    [appointmentType, selectedPackage]
  );

  const applicableBenefits = useMemo(() => {
    if (!selectedMembership) return [];

    return selectedMembership.membership_plan_benefits.map((benefit) => ({
      ...benefit,
      summary: {
        applies: doesBenefitApplyToAppointmentType(benefit, appointmentType),
        text: summarizeBenefit(benefit),
      },
    }));
  }, [appointmentType, selectedMembership]);

  const matchingBenefits = applicableBenefits.filter((benefit) => benefit.summary.applies);

  const isFloorRental = appointmentType === "floor_space_rental";
  const showPackageSection = !["group_class", "practice_party", "event", "floor_space_rental"].includes(
    appointmentType
  );
  const showPartnerSection = appointmentType === "private_lesson";

  function addFloorRentalSlot() {
    if (!slotDraft.date || !slotDraft.startTime || !slotDraft.endTime) {
      return;
    }

    setFloorRentalSlots((current) => [...current, slotDraft]);
    setSlotDraft({
      date: "",
      startTime: "",
      endTime: "",
    });
  }

  function removeFloorRentalSlot(index: number) {
    setFloorRentalSlots((current) => current.filter((_, i) => i !== index));
  }

  return (
    <form action={formAction} className="space-y-5 md:space-y-6">
      <input
        type="hidden"
        name="slotsJson"
        value={isFloorRental ? JSON.stringify(floorRentalSlots) : ""}
      />
      <input
        type="hidden"
        name="overrideRoomConflict"
        value={overrideRoomConflict ? "true" : "false"}
      />
      <input
        type="hidden"
        name="partnerClientId"
        value={showPartnerSection ? partnerClientId : ""}
      />

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">
              New Appointment
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
              Create a new appointment, then review package and membership coverage
              before saving. The mobile layout is tightened for faster studio use on
              phones and tablets.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:min-w-[280px]">
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending
                ? "Saving..."
                : isFloorRental
                ? "Create Floor Rentals"
                : "Create Appointment"}
            </button>

            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              Status will save as{" "}
              <span className="font-medium text-slate-900">Scheduled</span>.
            </div>
          </div>
        </div>

        {state.error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.08fr_0.92fr] xl:items-start">
        <div className="space-y-5">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <div className="mb-4">
              <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
                Appointment Details
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Start with the core scheduling details.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div className="md:col-span-2">
                <label htmlFor="appointmentType" className="mb-1.5 block text-sm font-medium">
                  Appointment Type
                </label>
                <select
                  id="appointmentType"
                  name="appointmentType"
                  value={appointmentType}
                  onChange={(e) => setAppointmentType(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  <option value="private_lesson">Private Lesson</option>
                  <option value="group_class">Group Class</option>
                  <option value="intro_lesson">Intro Lesson</option>
                  <option value="coaching">Coaching</option>
                  <option value="practice_party">Practice Party</option>
                  <option value="event">Event</option>
                  <option value="floor_space_rental">Floor Space Rental</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <label htmlFor="title" className="mb-1.5 block text-sm font-medium">
                  Title
                </label>
                <input
                  id="title"
                  name="title"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  placeholder={
                    isFloorRental ? "Optional rental title" : "Optional custom title"
                  }
                />
              </div>

              <div>
                <label htmlFor="clientId" className="mb-1.5 block text-sm font-medium">
                  Client
                </label>
                <select
                  id="clientId"
                  name="clientId"
                  value={clientId}
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setPartnerClientId("");
                    setLinkedPackageId("");
                  }}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  <option value="">Select client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.first_name} {client.last_name}
                    </option>
                  ))}
                </select>
              </div>

              {showPartnerSection ? (
                <div>
                  <label
                    htmlFor="partnerClientId"
                    className="mb-1.5 block text-sm font-medium"
                  >
                    Partner
                  </label>
                  <select
                    id="partnerClientId"
                    value={partnerClientId}
                    onChange={(e) => setPartnerClientId(e.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  >
                    <option value="">
                      {linkedPartners.length > 0
                        ? "No partner selected"
                        : "No linked partners available"}
                    </option>
                    {linkedPartners.map((partner) => (
                      <option key={partner.id} value={partner.id}>
                        {partner.first_name} {partner.last_name}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-slate-500">
                    Optional. Link a student's saved partner for a couple lesson.
                  </p>
                </div>
              ) : null}

              <div>
                <label htmlFor="instructorId" className="mb-1.5 block text-sm font-medium">
                  Instructor
                </label>
                <select
                  id="instructorId"
                  name="instructorId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  <option value="">Select instructor</option>
                  {instructors.map((instructor) => (
                    <option key={instructor.id} value={instructor.id}>
                      {instructor.first_name} {instructor.last_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="roomId" className="mb-1.5 block text-sm font-medium">
                  Room
                </label>
                <select
                  id="roomId"
                  name="roomId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                >
                  <option value="">Select room</option>
                  {rooms.map((room) => (
                    <option key={room.id} value={room.id}>
                      {room.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="startsAt" className="mb-1.5 block text-sm font-medium">
                  Starts At
                </label>
                <input
                  id="startsAt"
                  name="startsAt"
                  type="datetime-local"
                  required={!isFloorRental}
                  disabled={isFloorRental}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm disabled:bg-slate-100 disabled:text-slate-400"
                />
              </div>

              <div>
                <label htmlFor="endsAt" className="mb-1.5 block text-sm font-medium">
                  Ends At
                </label>
                <input
                  id="endsAt"
                  name="endsAt"
                  type="datetime-local"
                  required={!isFloorRental}
                  disabled={isFloorRental}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm disabled:bg-slate-100 disabled:text-slate-400"
                />
              </div>
            </div>
          </section>

          {isFloorRental ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 md:p-5">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">
                    Floor Rental Slots
                  </h3>
                  <p className="mt-1 text-sm text-slate-600">
                    Add one or more rental blocks. Each slot will be created as its own
                    floor rental appointment.
                  </p>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-4">
                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Slot Date</label>
                    <input
                      type="date"
                      value={slotDraft.date}
                      onChange={(e) =>
                        setSlotDraft((current) => ({ ...current, date: e.target.value }))
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium">Start Time</label>
                    <input
                      type="time"
                      value={slotDraft.startTime}
                      onChange={(e) =>
                        setSlotDraft((current) => ({
                          ...current,
                          startTime: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-sm font-medium">End Time</label>
                    <input
                      type="time"
                      value={slotDraft.endTime}
                      onChange={(e) =>
                        setSlotDraft((current) => ({
                          ...current,
                          endTime: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                    />
                  </div>

                  <div className="flex items-end">
                    <button
                      type="button"
                      onClick={addFloorRentalSlot}
                      className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-100"
                    >
                      Add Slot
                    </button>
                  </div>
                </div>

                {floorRentalSlots.length === 0 ? (
                  <div className="mt-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-slate-500">
                    No floor rental slots added yet.
                  </div>
                ) : (
                  <div className="mt-4 space-y-3">
                    {floorRentalSlots.map((slot, index) => (
                      <div
                        key={`${slot.date}-${slot.startTime}-${slot.endTime}-${index}`}
                        className="rounded-xl border border-slate-200 bg-white p-4"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <p className="font-medium text-slate-900">
                              {formatShortDate(slot.date)}
                            </p>
                            <p className="text-sm text-slate-600">
                              {slot.startTime} – {slot.endTime}
                            </p>
                          </div>

                          <button
                            type="button"
                            onClick={() => removeFloorRentalSlot(index)}
                            className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          ) : null}

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            {showPackageSection ? (
              <div>
                <label htmlFor="clientPackageId" className="mb-1.5 block text-sm font-medium">
                  Linked Package
                </label>
                <select
                  id="clientPackageId"
                  name="clientPackageId"
                  value={linkedPackageId}
                  onChange={(e) => setLinkedPackageId(e.target.value)}
                  className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  disabled={!clientId}
                >
                  <option value="">
                    {clientId ? "No linked package" : "Select a client first"}
                  </option>
                  {selectedPackages.map((pkg) => (
                    <option key={pkg.id} value={pkg.id}>
                      {pkg.name_snapshot}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input type="hidden" name="clientPackageId" value="" />
            )}

            {isFloorRental ? (
              <div className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 md:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-emerald-900">
                      Floor Rental Pricing
                    </h3>
                    <p className="mt-1 text-sm text-emerald-800">
                      Set the rental amount now so staff can charge it and the
                      appointment can track payment status.
                    </p>
                  </div>
                  <span className="inline-flex w-fit rounded-full bg-white px-3 py-1 text-xs font-medium text-emerald-700">
                    {paymentStatusLabel(paymentStatus)}
                  </span>
                </div>

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div>
                    <label htmlFor="priceAmount" className="mb-1.5 block text-sm font-medium">
                      Rental Amount
                    </label>
                    <input
                      id="priceAmount"
                      name="priceAmount"
                      type="number"
                      min="0"
                      step="0.01"
                      value={priceAmount}
                      onChange={(e) => setPriceAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full rounded-xl border border-emerald-300 bg-white px-3 py-3 text-sm"
                    />
                    <p className="mt-1 text-xs text-emerald-700">
                      Leave blank only if you want to price it later.
                    </p>
                  </div>

                  <div>
                    <label htmlFor="paymentStatus" className="mb-1.5 block text-sm font-medium">
                      Initial Payment Status
                    </label>
                    <select
                      id="paymentStatus"
                      name="paymentStatus"
                      value={paymentStatus}
                      onChange={(e) => setPaymentStatus(e.target.value)}
                      className="w-full rounded-xl border border-emerald-300 bg-white px-3 py-3 text-sm"
                    >
                      <option value="unpaid">Unpaid</option>
                      <option value="partial">Partially Paid</option>
                      <option value="paid">Paid</option>
                      <option value="waived">Waived</option>
                    </select>
                  </div>
                </div>

                <div className="mt-4 rounded-xl border border-emerald-200 bg-white p-4 text-sm text-emerald-900">
                  <p className="font-medium">Recommended workflow</p>
                  <p className="mt-1 text-emerald-800">
                    Create the rental as unpaid, then collect payment from the detail
                    page with Charge, Purchase, or Record Manual Payment.
                  </p>
                </div>
              </div>
            ) : (
              <>
                <input type="hidden" name="priceAmount" value="" />
                <input type="hidden" name="status" value="scheduled" />
                <input type="hidden" name="paymentStatus" value="unpaid" />
              </>
            )}

            <div className="mt-5">
              <label htmlFor="notes" className="mb-1.5 block text-sm font-medium">
                Notes
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={4}
                className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
              />
            </div>

            <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <label className="flex items-start gap-3 text-sm text-amber-900">
                <input
                  type="checkbox"
                  checked={overrideRoomConflict}
                  onChange={(e) => setOverrideRoomConflict(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-amber-300"
                />
                <span>
                  Override room conflict warning and continue.
                  <span className="mt-1 block text-xs text-amber-700">
                    Use this only when you intentionally want to double-book the room.
                  </span>
                </span>
              </label>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button
                type="submit"
                disabled={pending}
                className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {pending
                  ? "Saving..."
                  : isFloorRental
                  ? "Create Floor Rentals"
                  : "Create Appointment"}
              </button>
            </div>
          </section>
        </div>

        <div className="space-y-5 xl:sticky xl:top-6">
          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
              Package Health
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Review the linked package before scheduling against it.
            </p>

            {!showPackageSection ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Package linking is not used for{" "}
                {appointmentTypeLabel(appointmentType).toLowerCase()}.
              </div>
            ) : !clientId ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Select a client to review package options.
              </div>
            ) : !selectedPackage ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                No linked package selected.
              </div>
            ) : (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 md:p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-semibold text-slate-900">
                    {selectedPackage.name_snapshot}
                  </p>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${packageHealthClass(
                      packageHealth
                    )}`}
                  >
                    {packageHealthLabel(packageHealth)}
                  </span>
                </div>

                <p className="mt-3 text-sm text-slate-600">
                  {summarizeClientPackageItems(selectedPackage.client_package_items)}
                </p>

                {"expiration_date" in selectedPackage ? (
                  <p className="mt-2 text-sm text-slate-500">
                    Expires: {formatShortDate(selectedPackage.expiration_date ?? null)}
                  </p>
                ) : null}

                {packageWarningMessage(packageHealth) ? (
                  <div
                    className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
                      packageHealth === "depleted" ||
                      packageHealth === "inactive" ||
                      packageHealth === "expired"
                        ? "border-red-200 bg-red-50 text-red-800"
                        : "border-amber-200 bg-amber-50 text-amber-800"
                    }`}
                  >
                    {packageWarningMessage(packageHealth)}
                  </div>
                ) : null}
              </div>
            )}
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
            <h3 className="text-lg font-semibold text-slate-900 md:text-xl">
              Membership Benefits
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              Check whether the client’s active membership includes or discounts this
              appointment type.
            </p>

            {!clientId ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                Select a client to review membership coverage.
              </div>
            ) : !selectedMembership ? (
              <div className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                No active membership found for this client.
              </div>
            ) : (
              <div className="mt-5 space-y-4">
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 md:p-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <p className="font-semibold text-slate-900">
                      {selectedMembership.name_snapshot}
                    </p>
                    <span className="inline-flex rounded-full bg-green-50 px-2.5 py-1 text-xs font-medium text-green-700">
                      {selectedMembership.status}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border bg-white p-4">
                      <p className="text-sm text-slate-500">Billing</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatCurrency(selectedMembership.price_snapshot)} /{" "}
                        {billingIntervalLabel(selectedMembership.billing_interval_snapshot)}
                      </p>
                    </div>

                    <div className="rounded-xl border bg-white p-4">
                      <p className="text-sm text-slate-500">Current Period</p>
                      <p className="mt-1 font-medium text-slate-900">
                        {formatShortDate(selectedMembership.current_period_start)} –{" "}
                        {formatShortDate(selectedMembership.current_period_end)}
                      </p>
                    </div>
                  </div>
                </div>

                {matchingBenefits.length > 0 ? (
                  <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
                    This membership includes or discounts the selected appointment type.
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    No direct membership benefit applies to{" "}
                    {appointmentTypeLabel(appointmentType).toLowerCase()}.
                  </div>
                )}

                <div className="space-y-3">
                  {applicableBenefits.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-slate-500">
                      No benefits configured on this membership.
                    </div>
                  ) : (
                    applicableBenefits.map((benefit, index) => (
                      <div
                        key={`${benefit.benefit_type}-${index}`}
                        className={`rounded-xl border p-4 ${
                          benefit.summary.applies
                            ? "border-green-200 bg-green-50"
                            : "border-slate-200 bg-slate-50"
                        }`}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">
                            {benefitTypeLabel(benefit.benefit_type)}
                          </p>

                          {benefit.summary.applies ? (
                            <span className="inline-flex rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                              Applies
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full bg-slate-200 px-2 py-1 text-xs font-medium text-slate-700">
                              Not used here
                            </span>
                          )}
                        </div>

                        <p className="mt-2 text-sm text-slate-600">
                          {benefit.summary.text}
                        </p>

                        {benefit.applies_to ? (
                          <p className="mt-1 text-xs text-slate-500">
                            Applies to: {benefit.applies_to}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      </div>
    </form>
  );
}