import { afterEach, describe, expect, it } from "vitest";
import { getLivenessErrorContent } from "./livenessErrors";

describe("getLivenessErrorContent", () => {
  afterEach(() => {
    delete (
      window as Window & {
        Telegram?: { WebApp?: unknown };
      }
    ).Telegram;
  });

  it("maps DEFAULT_CAMERA_NOT_FOUND_ERROR to Telegram-specific guidance", () => {
    (
      window as Window & {
        Telegram?: { WebApp?: unknown };
      }
    ).Telegram = { WebApp: {} };

    const content = getLivenessErrorContent({
      state: "DEFAULT_CAMERA_NOT_FOUND_ERROR",
    });

    expect(content.title).toMatch(/front camera unavailable/i);
    expect(content.detail).toMatch(/Telegram's in-app browser/i);
    expect(content.showOpenInBrowser).toBe(true);
  });

  it("maps MOBILE_LANDSCAPE_ERROR to portrait guidance", () => {
    const content = getLivenessErrorContent({
      state: "MOBILE_LANDSCAPE_ERROR",
    });

    expect(content.title).toMatch(/rotate your phone upright/i);
    expect(content.detail).toMatch(/portrait mode/i);
    expect(content.hint).toMatch(/vertically/i);
  });
});
