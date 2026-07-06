declare module "expo-notifications" {
  export type PermissionStatus = "granted" | "denied" | "undetermined";

  export function setNotificationHandler(handler: {
    handleNotification: () => Promise<{
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
      shouldShowBanner: boolean;
      shouldShowList: boolean;
    }>;
  }): void;

  export function getPermissionsAsync(): Promise<{ status: PermissionStatus; granted: boolean }>;

  export function requestPermissionsAsync(): Promise<{ status: PermissionStatus; granted: boolean }>;

  export function getExpoPushTokenAsync(options?: { projectId?: string }): Promise<{ data: string }>;
}
