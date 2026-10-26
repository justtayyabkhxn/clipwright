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

/** Local storage: the browser streams the file to /api/upload. */
type ProxyUploadAuthorization = {
  directUpload: false;
};

type S3UploadAuthorization = {
  storage: "s3";
  video_path: string;
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
};

/** Object storage: the browser uploads parts straight to presigned URLs. */
type UploadAuthorization = ProxyUploadAuthorization | S3UploadAuthorization;

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

async function requestUploadAuthorization(file: File): Promise<UploadAuthorization> {
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

  return response.json() as Promise<UploadAuthorization>;
}

export async function uploadVideoFile(
  file: File,
  maxBytes: number = maxVideoUploadBytes(),
): Promise<string> {
  if (file.size > maxBytes) {
    throw new Error(uploadTooLargeMessage(maxBytes, file.size));
  }

  const uploadAuthorization = await requestUploadAuthorization(file);
  if ("storage" in uploadAuthorization) {
    return uploadVideoFileToS3(file, uploadAuthorization);
  }
  return uploadVideoFileViaProxy(file, maxBytes);
}

async function uploadVideoFileToS3(file: File, authorization: S3UploadAuthorization): Promise<string> {
  const completedParts: { partNumber: number; etag: string }[] = [];
  const controller = new AbortController();
  const payload = { video_path: authorization.video_path, uploadId: authorization.uploadId };
  let nextPart = 0;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(3, authorization.parts.length) }, async () => {
    while (nextPart < authorization.parts.length && !controller.signal.aborted) {
      const part = authorization.parts[nextPart++];
      try {
        const start = (part.partNumber - 1) * authorization.partSize;
        let partUrl = part.url;
        let response: Response | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            response = await fetch(partUrl, {
              method: "PUT",
              body: file.slice(start, Math.min(file.size, start + authorization.partSize)),
              signal: controller.signal,
            });
            if (response.ok) break;
            if (response.status === 403 && attempt < 2) {
              // Refresh with current credentials without discarding completed
              // parts when an upload lasts longer than the signed URL/session.
              const refreshed = await fetch("/api/upload/parts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...payload, partNumbers: [part.partNumber] }),
                signal: controller.signal,
              });
              if (!refreshed.ok) throw new Error("Video upload authorization could not be refreshed.");
              const result = await refreshed.json();
              const freshPart = result.parts?.find((item: { partNumber: number; url: string }) => item.partNumber === part.partNumber);
              if (!freshPart?.url) throw new Error("Video upload authorization could not be refreshed.");
              partUrl = freshPart.url;
              continue;
            }
            if (response.status < 500) throw new Error("Video upload failed. Please try again.");
          } catch (error) {
            if (controller.signal.aborted || attempt === 2) throw error;
          }
        }
        const etag = response?.headers.get("ETag");
        if (!response?.ok || !etag) {
          throw new Error("Video upload failed. Please try again.");
        }
        completedParts.push({ partNumber: part.partNumber, etag });
      } catch (error) {
        failure ??= error;
        controller.abort();
      }
    }
  });
  await Promise.all(workers);
  try {
    if (failure) throw failure;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch("/api/upload/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...payload, parts: completedParts.sort((a, b) => a.partNumber - b.partNumber) }),
        });
        if (response.ok || response.status < 500) break;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    if (!response?.ok) {
      if (!response) throw new Error("Video upload could not be completed.");
      throw new Error(formatSupportMessage(await parseApiError(response, "Video upload could not be completed.")));
    }
    const result = await response.json();
    if (typeof result.video_path !== "string" || !result.video_path) {
      throw new Error("Upload finished without a video path. Please try again.");
    }
    return result.video_path;
  } catch (error) {
    await fetch("/api/upload/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => undefined);
    throw error;
  }
}

export async function uploadVideoFileViaProxy(
  file: File,
  maxBytes: number = maxVideoUploadBytes(),
): Promise<string> {
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
