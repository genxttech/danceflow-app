declare module "expo-image-picker" {
  export type ImagePickerAsset = {
    mimeType?: string | null;
    uri: string;
  };

  export type ImagePickerResult =
    | { canceled: true; assets?: ImagePickerAsset[] }
    | { canceled: false; assets: ImagePickerAsset[] };

  export function requestMediaLibraryPermissionsAsync(): Promise<{ granted: boolean }>;

  export function launchImageLibraryAsync(options?: {
    allowsEditing?: boolean;
    aspect?: [number, number];
    mediaTypes?: string[] | string;
    quality?: number;
  }): Promise<ImagePickerResult>;
}
