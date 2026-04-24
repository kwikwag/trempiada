type LivenessIntroScreenProps = {
  onStart: () => void;
  onReturnToTelegram: () => void;
};

export function LivenessIntroScreen({ onStart, onReturnToTelegram }: LivenessIntroScreenProps) {
  return (
    <main className="app-shell intro-shell">
      <section className="intro-card">
        <p className="eyebrow">Trempiada</p>
        <h1>Before you start</h1>
        <p className="status-detail">
          This one-time check uses your phone&apos;s front camera and may flash bright colors.
        </p>
        <div className="intro-note">
          <p className="intro-note__title">Photosensitivity and brightness</p>
          <p className="intro-note__body">
            If flashing light is a problem for you, do not continue. Otherwise, turn your screen
            brightness up, face a steady light source, and keep your whole face visible.
          </p>
        </div>
        <div className="intro-note">
          <p className="intro-note__title">How this works</p>
          <p className="intro-note__body">
            After you tap start, allow camera access if asked, hold the phone upright, and follow
            the motion prompt. If anything fails, go back to Telegram and start a fresh check.
          </p>
        </div>
        <div className="status-actions">
          <button className="primary-button" type="button" onClick={onStart}>
            Start video check
          </button>
          <button className="secondary-button" type="button" onClick={onReturnToTelegram}>
            Return to Telegram
          </button>
        </div>
      </section>
    </main>
  );
}
