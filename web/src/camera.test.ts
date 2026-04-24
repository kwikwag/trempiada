import { describe, expect, it, vi } from "vitest";
import { clearStoredLivenessCameraId, probePreferredCameraDeviceId } from "./camera";

describe("camera helpers", () => {
  it("clears Amplify's cached camera id", () => {
    const removeItem = vi.fn();

    clearStoredLivenessCameraId({ removeItem });

    expect(removeItem).toHaveBeenCalledWith("AmplifyLivenessCameraId");
  });

  it("probes the preferred front camera device id and stops tracks", async () => {
    const stop = vi.fn();
    const getSettings = vi.fn().mockReturnValue({ deviceId: "front-camera-1" });
    const stream = {
      getVideoTracks: () => [{ getSettings }],
      getTracks: () => [{ stop }],
    };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(stream),
      },
    });

    const deviceId = await probePreferredCameraDeviceId();

    expect(deviceId).toBe("front-camera-1");
    expect(stop).toHaveBeenCalled();
  });
});
