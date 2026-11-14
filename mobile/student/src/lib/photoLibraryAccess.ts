import { Platform } from "react-native";
import * as ImagePicker from "expo-image-picker";

/**
 * Whether the photo picker may open. Android uses the system picker, which needs no permission (and
 * the storage permissions are not in the manifest, so asking on Android 12 and older would be denied
 * forever). iOS keeps the library permission prompt.
 */
export async function ensurePhotoLibraryAccess(os: string = Platform.OS): Promise<boolean> {
  if (os === "android") return true;
  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  return Boolean(permission.granted);
}
