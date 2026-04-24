import { getLivenessErrorContent, type LivenessErrorInfo } from "./livenessErrors";

type LivenessErrorScreenProps = {
  error: LivenessErrorInfo;
  onRetryHere: () => void;
  onReturnToTelegram: () => void;
};

export function LivenessErrorScreen({
  error,
  onRetryHere,
  onReturnToTelegram,
}: LivenessErrorScreenProps) {
  const content = getLivenessErrorContent(error);

  return (
    <main className="app-shell">
      <section className="status-card status-card--error">
        <p className="eyebrow">Trempiada</p>
        <h1>{content.title}</h1>
        <p className="status-detail">{content.detail}</p>
        {content.hint ? <p className="status-hint">{content.hint}</p> : null}
        <div className="status-actions">
          <button className="primary-button" type="button" onClick={onReturnToTelegram}>
            Return to Telegram
          </button>
          <button className="secondary-button" type="button" onClick={onRetryHere}>
            Retry this page
          </button>
          {content.showOpenInBrowser ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                window.open(window.location.href, "_blank", "noopener,noreferrer");
              }}
            >
              Open in browser
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
}
