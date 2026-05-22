"use server";

import {
  createTicketTypeAction as createTicketTypeActionBase,
  updateTicketTypeAction as updateTicketTypeActionBase,
} from "./tickets/actions";

import {
  bookPrivateLessonSlotOfflineAction as bookPrivateLessonSlotOfflineActionBase,
  holdPrivateLessonSlotAction as holdPrivateLessonSlotActionBase,
  releasePrivateLessonSlotAction as releasePrivateLessonSlotActionBase,
} from "../actions";

export async function createTicketTypeAction(formData: FormData) {
  return await createTicketTypeActionBase(formData);
}

export async function updateTicketTypeAction(formData: FormData) {
  return await updateTicketTypeActionBase(formData);
}

export async function bookPrivateLessonSlotOfflineAction(formData: FormData) {
  return await bookPrivateLessonSlotOfflineActionBase(formData);
}

export async function holdPrivateLessonSlotAction(formData: FormData) {
  return await holdPrivateLessonSlotActionBase(formData);
}

export async function releasePrivateLessonSlotAction(formData: FormData) {
  return await releasePrivateLessonSlotActionBase(formData);
}

