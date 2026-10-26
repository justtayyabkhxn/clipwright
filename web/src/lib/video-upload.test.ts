import { uploadTooLargeMessage, uploadVideoFile, validateVideoSourceUrl } from "./video-upload";

describe("video uploads", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a file over the upload limit before requesting authorization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 4_000_000_001 });
    await expect(uploadVideoFile(file, 4_000_000_000)).rejects.toThrow(uploadTooLargeMessage(4_000_000_000, file.size));
    expect(fetchMock).not.toHaveBeenCalled();
  });

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
