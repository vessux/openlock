import { describe, expect, it } from "bun:test";
import { formatBytes, formatDuration } from "./format";

describe("formatBytes", () => {
  it("formats kilobytes under 1 MB", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(512)).toBe("512 KB");
    expect(formatBytes(1023)).toBe("1023 KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatBytes(1024)).toBe("1.0 MB");
    expect(formatBytes(42_000)).toBe("41.0 MB");
    expect(formatBytes(1_048_575)).toBe("1024.0 MB");
  });

  it("formats gigabytes with one decimal", () => {
    expect(formatBytes(1_048_576)).toBe("1.0 GB");
    expect(formatBytes(2_500_000)).toBe("2.4 GB");
  });
});

describe("formatDuration", () => {
  it("renders seconds when under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("renders minutes when under an hour", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(3_540_000)).toBe("59m");
  });

  it("renders hours and minutes when under a day", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m");
    expect(formatDuration(8_040_000)).toBe("2h 14m");
  });

  it("renders days and hours when over a day", () => {
    expect(formatDuration(86_400_000)).toBe("1d 0h");
    expect(formatDuration(180_000_000)).toBe("2d 2h");
  });
});
