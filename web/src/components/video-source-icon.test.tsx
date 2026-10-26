import { render, screen } from "@testing-library/react";
import { VideoSourceIcon, videoSourceKind } from "./video-source-icon";

it("maps stored source types to their source", () => {
  expect(videoSourceKind("youtube")).toBe("youtube");
  expect(videoSourceKind("upload")).toBe("upload");
  expect(videoSourceKind("video_url")).toBe("upload");
  expect(videoSourceKind(undefined)).toBe("upload");
});

it("labels the YouTube brand mark", () => {
  render(<VideoSourceIcon source="youtube" />);
  const icon = screen.getByRole("img", { name: "YouTube" });
  expect(icon).toHaveAttribute("data-source", "youtube");
  expect(icon).toHaveAttribute("fill", "currentColor");
});

it("hides decorative icons from assistive tech", () => {
  const { container } = render(<VideoSourceIcon source="youtube" aria-hidden />);
  expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  expect(screen.queryByRole("img")).toBeNull();
});
