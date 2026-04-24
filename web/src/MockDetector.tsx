type MockDetectorProps = {
  onComplete: () => void;
  onError: (message: string) => void;
};

export function MockDetector({ onComplete, onError }: MockDetectorProps) {
  return (
    <div className="mock-detector" data-testid="mock-detector">
      <div className="mock-detector__stage">
        <div className="mock-detector__oval" />
        <div className="mock-detector__camera-label">Mock camera preview</div>
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
