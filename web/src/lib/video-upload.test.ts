import { uploadTooLargeMessage, uploadVideoFile, validateVideoSourceUrl } from "./video-upload";

describe("S3 video uploads", () => {
  it("rejects a file over the upload limit before requesting authorization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 4_000_000_001 });
    await expect(uploadVideoFile(file, 4_000_000_000)).rejects.toThrow(uploadTooLargeMessage(4_000_000_000, file.size));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => vi.unstubAllGlobals());

  function authorization() {
    return { storage: "s3", video_path: "upload://s3/owner/id/video.mp4", uploadId: "upload",
      partSize: 3, parts: [{ partNumber: 1, url: "https://s3.test/1" }, { partNumber: 2, url: "https://s3.test/2" }] };
  }

  it("uploads parts directly and completes them in order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url.startsWith("https://s3.test/")) return new Response(null, { headers: { ETag: url.endsWith("1") ? "first" : "second" } });
      if (url === "/api/upload/complete") {
        expect(JSON.parse(init?.body as string).parts).toEqual([{ partNumber: 1, etag: "first" }, { partNumber: 2, etag: "second" }]);
        return Response.json({ video_path: authorization().video_path });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["abcdef"], "video.mp4", { type: "video/mp4" });
    await expect(uploadVideoFile(file)).resolves.toBe(authorization().video_path);
    const puts = fetchMock.mock.calls.filter(([url]) => url.startsWith("https://s3.test/"));
    expect(puts).toHaveLength(2);
    expect(puts.every(([, init]) => init?.method === "PUT" && (init.body as Blob).size === 3)).toBe(true);
    expect(puts.every(([, init]) => !init?.headers)).toBe(true);
  });

  it("aborts the multipart upload when a part fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url.startsWith("https://s3.test/")) return new Response(null, { status: 503 });
      if (url === "/api/upload/abort") return Response.json({ message: "cancelled" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(new File(["abcdef"], "video.mp4"))).rejects.toThrow("Video upload failed");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/abort")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/complete")).toBe(false);
  });

  it("refreshes expired part URLs without discarding completed parts", async () => {
    let refreshes = 0;
    let completions = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url === "https://s3.test/1") return new Response(null, { headers: { ETag: "first" } });
      if (url === "https://s3.test/2") return new Response(null, { status: 403 });
      if (url === "/api/upload/parts") {
        expect(JSON.parse(init?.body as string).partNumbers).toEqual([2]);
        refreshes++;
        return Response.json({ parts: [{ partNumber: 2, url: "https://s3.test/fresh" }] });
      }
      if (url === "https://s3.test/fresh") return new Response(null, { headers: { ETag: "second" } });
      if (url === "/api/upload/complete") {
        completions++;
        if (completions === 1) return new Response(null, { status: 503 });
        expect(JSON.parse(init?.body as string).parts).toEqual([{ partNumber: 1, etag: "first" }, { partNumber: 2, etag: "second" }]);
        return Response.json({ video_path: authorization().video_path });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(new File(["abcdef"], "video.mp4"))).resolves.toBe(authorization().video_path);
    expect(refreshes).toBe(1);
    expect(completions).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://s3.test/1")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/abort")).toBe(false);
  });

});

describe("local video uploads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("streams the file to /api/upload when storage is local", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return Response.json({ directUpload: false });
      if (url === "/api/upload") {
        expect((init?.body as FormData).get("video")).toBeInstanceOf(File);
        return Response.json({ message: "ok", video_path: "upload://0b0c7c1e-2f5e-4b7a-9d1a-8a3c2b1d0e9f.mp4" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(new File(["abc"], "talk.mp4", { type: "video/mp4" }))).resolves.toBe("upload://0b0c7c1e-2f5e-4b7a-9d1a-8a3c2b1d0e9f.mp4");
  });

  it("explains a 413 with the upload limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (
      url === "/api/upload/authorization" ? Response.json({ directUpload: false }) : new Response(null, { status: 413 })
    )));
    await expect(uploadVideoFile(new File(["abc"], "talk.mp4"), 2_000_000_000)).rejects.toThrow(uploadTooLargeMessage(2_000_000_000));
  });
});

describe("supported video source URLs", () => {
  it.each([
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://youtu.be/abcdefghijk",
    "https://m.youtube.com/watch?v=abcdefghijk&t=30",
    "https://www.youtube.com/embed/abcdefghijk",
  ])("accepts %s", (url) => expect(validateVideoSourceUrl(url)).toEqual({ source: "youtube" }));
  it.each(["https://www.youtube.com/watch?v=short", "not a url", "ftp://youtube.com/watch?v=abcdefghijk"])("rejects malformed YouTube input %s", (url) =>
    expect(validateVideoSourceUrl(url).error).toBe("Enter a valid YouTube video URL."));
  it.each(["https://www.twitch.tv/videos/12345", "https://kick.com/video/12345678-1234-1234-1234-123456789abc", "https://vimeo.com/1"])("rejects other hosts like %s", (url) =>
    expect(validateVideoSourceUrl(url).error).toBe("Only YouTube links are supported. Upload the file instead."));
});
