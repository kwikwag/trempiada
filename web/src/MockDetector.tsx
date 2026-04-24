import { useEffect, useRef, useState } from "react";

type MockDetectorProps = {
  onComplete: () => void;
  onError: (message: string) => void;
};

export function MockDetector({ onComplete, onError }: MockDetectorProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let activeStream: MediaStream | null = null;

    async function startPreview() {
      if (!navigator.mediaDevices?.getUserMedia || !videoRef.current) {
        setPreviewState("unavailable");
        return;
      }

      try {
        activeStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "user" },
            width: { ideal: 720 },
            height: { ideal: 1280 },
          },
        });

        if (!videoRef.current) {
          activeStream.getTracks().forEach((track) => track.stop());
          return;
        }

        videoRef.current.srcObject = activeStream;
        await videoRef.current.play().catch(() => undefined);
        setPreviewState("ready");
      } catch {
        setPreviewState("unavailable");
      }
    }

    void startPreview();

    return () => {
      activeStream?.getTracks().forEach((track) => track.stop());
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, []);

  return (
    <div className="mock-detector" data-testid="mock-detector">
      <div className="mock-detector__stage">
        <video
          ref={videoRef}
          className={`mock-detector__video ${
            previewState === "ready" ? "mock-detector__video--ready" : ""
          }`}
          autoPlay
          muted
          playsInline
        />
        <div className="mock-detector__oval" />
        <div className="mock-detector__camera-label">
          {previewState === "ready" ? "Live camera preview" : "Mock camera preview"}
        </div>
        {previewState !== "ready" ? (
          <div className="mock-detector__preview-fallback">
            {previewState === "loading"
              ? "Opening your camera for a local preview..."
              : "Camera preview unavailable in this browser, but the rest of the mock flow still works."}
          </div>
        ) : null}
      </div>
      <div className="mock-detector__panel">
        <p className="mock-detector__title">Mock liveness mode</p>
        <p className="mock-detector__body">
          This local mode exercises the Telegram handoff, layout, and error states without sending a
          real liveness stream to AWS.
        </p>
        <div className="mock-detector__actions">
          <button className="primary-button" type="button" onClick={onComplete}>
            Simulate success
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => onError("Simulated detector timeout. Start a new check from Telegram.")}
          >
            Simulate timeout
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              onError("Rotate your device upright before retrying the liveness check.")
            }
          >
            Simulate landscape error
          </button>
        </div>
      </div>
    </div>
  );
}
