import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentMarketplaceItem = {
  id: string;
  studioId: string;
  studioName: string;
  name: string;
  description: string | null;
  itemType: "digital_video" | "video_series";
  price: number;
  currency: string;
  imageUrl: string | null;
  instructorName: string | null;
  skillLevel: string | null;
  danceStyle: string | null;
  durationSeconds: number | null;
  owned: boolean;
};

export type StudentMarketplaceCheckout = {
  clientSecret: string;
  orderId: string;
  publishableKey?: string;
};

export async function loadStudentMarketplace() {
  const response = await danceflowApiFetch<{ items: StudentMarketplaceItem[] }>(
    "/api/student/marketplace"
  );
  return response.items;
}

export function loadStudentMarketplaceItem(catalogItemId: string) {
  return danceflowApiFetch<StudentMarketplaceItem>(
    `/api/student/marketplace/${encodeURIComponent(catalogItemId)}`
  );
}

export function createStudentMarketplaceCheckout(catalogItemId: string) {
  return danceflowApiFetch<StudentMarketplaceCheckout>(
    `/api/student/marketplace/${encodeURIComponent(catalogItemId)}/checkout`,
    { method: "POST" }
  );
}

export function confirmStudentMarketplaceOrder(orderId: string) {
  return danceflowApiFetch<{ confirmed: boolean; orderId: string }>(
    `/api/student/commerce/orders/${encodeURIComponent(orderId)}/confirm`,
    { method: "POST" }
  );
}
