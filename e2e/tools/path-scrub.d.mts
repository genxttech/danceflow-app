export function relativeInside(baseDir: string | undefined | null, p: string): string | null;
export function scrubString(text: string, baseDir?: string | null): string;
export function scrubValue<T>(value: T, baseDir?: string | null): T;
export function hasLocalPath(text: string): boolean;
