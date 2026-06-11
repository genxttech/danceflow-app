export type NavItem = {
  label: string;
  href: string;
  icon: string;
  badge?: number | null;
};

export type NavSectionType = {
  title: string;
  items: NavItem[];
};

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  client_id: string | null;
  appointment_id: string | null;
};

export type WorkspaceItem = {
  studioId: string;
  studioRole: string;
  studioName: string;
  studioSlug: string | null;
  studioPublicName: string | null;
  isSelected: boolean;
};
