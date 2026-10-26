import { parseApiError, formatSupportMessage } from "@/lib/api-error";

/** Default upload cap: 4 GB. Matches the server's MAX_VIDEO_UPLOAD_BYTES default. */
export const DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 4_000_000_000;

export function maxVideoUploadBytes(): number {
  const raw = process.env.NEXT_PUBLIC_MAX_VIDEO_UPLOAD_BYTES;
  if (!raw) return DEFAULT_MAX_VIDEO_UPLOAD_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_VIDEO_UPLOAD_BYTES;
}

export function formatUploadLimit(bytes: number): string {
  if (bytes >= 1e9) {
    const gigabytes = bytes / 1e9;
    const rounded = Math.round(gigabytes * 10) / 10;
    return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)} GB`;
  }
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

export function uploadTooLargeMessage(limitBytes: number, fileBytes?: number): string {
  const limit = formatUploadLimit(limitBytes);
  if (fileBytes && fileBytes > limitBytes) {
    return `This file is ${formatUploadLimit(fileBytes)}, which is over the ${limit} upload limit. Try a shorter export or a smaller file.`;
  }
  return `This file is over the ${limit} upload limit. Try a shorter export or a smaller file.`;
}

// Only surface the font search box once the list is long enough to need it.
export const FONT_SEARCH_THRESHOLD = 8;

/** Links can only come from YouTube; anything else is uploaded as a file. */
export function validateVideoSourceUrl(value: string): { source?: "youtube"; error?: string } {
  let parsed: URL; try { parsed = new URL(value.trim()); } catch { return { error: "Enter a valid YouTube video URL." }; }
  if (!["http:", "https:"].includes(parsed.protocol)) return { error: "Enter a valid YouTube video URL." };
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (["youtu.be", "youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) return extractYouTubeVideoId(value) ? { source: "youtube" } : { error: "Enter a valid YouTube video URL." };
  return { error: "Only YouTube links are supported. Upload the file instead." };
}

const extractYouTubeVideoId = (value: string): string | null => {
  const input = value.trim();
  if (!input) return null;

  try {
    const parsed = new URL(input);
    const host = parsed.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = parsed.pathname.split("/").filter(Boolean)[0];
      return id && id.length === 11 ? id : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      const fromSearch = parsed.searchParams.get("v");
      if (fromSearch && fromSearch.length === 11) {
        return fromSearch;
      }

      const pathParts = parsed.pathname.split("/").filter(Boolean);
      const embedId = pathParts[0] === "embed" ? pathParts[1] : null;
      if (embedId && embedId.length === 11) {
        return embedId;
      }
    }
  } catch {
    return null;
  }

  return null;
};

export const getYouTubeThumbnailUrl = (value: string): string | null => {
  const videoId = extractYouTubeVideoId(value);
  return videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
};

/** Asks how to upload. Local storage always answers `{directUpload: false}`: stream to /api/upload. */
async function requestUploadAuthorization(file: File): Promise<void> {
  const response = await fetch("/api/upload/authorization", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type }),
    cache: "no-store",
  });

  if (!response.ok) {
    const uploadError = await parseApiError(
      response,
      `Upload authorization error: ${response.status}`,
    );
    throw new Error(formatSupportMessage(uploadError));
  }
}

export async function uploadVideoFile(
  file: File,
  maxBytes: number = maxVideoUploadBytes(),
): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(uploadTooLargeMessage(maxBytes, file.size));
  }

  await requestUploadAuthorization(file);

  const formData = new FormData();
  formData.append("video", file);

  const uploadResponse = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  if (!uploadResponse.ok) {
    const fallbackMessage =
      uploadResponse.status === 413
        ? uploadTooLargeMessage(maxBytes)
        : `Upload error: ${uploadResponse.status}`;
    const uploadError = await parseApiError(uploadResponse, fallbackMessage);
    throw new Error(formatSupportMessage(uploadError));
  }

  const uploadResult = await uploadResponse.json();
  if (typeof uploadResult.video_path !== "string" || !uploadResult.video_path) {
    throw new Error("Upload finished without a video path. Please try again.");
  }

  return uploadResult.video_path;
}
