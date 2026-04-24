import { useEffect, useMemo, useRef, useState } from "react";
import { Loader } from "@aws-amplify/ui-react";
import {
  FaceLivenessDetectorCore,
  type AwsCredentialProvider,
} from "@aws-amplify/ui-react-liveness";
import { clearStoredLivenessCameraId } from "./camera";
import { LivenessErrorScreen } from "./LivenessErrorScreen";
import { LivenessIntroScreen } from "./LivenessIntroScreen";
import { MockDetector } from "./MockDetector";

type AwsCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
};

type BootstrapCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: string;
};

type BootstrapResponse = {
  sessionId: string;
  region: string;
  credentials: AwsCredentials;
  returnToTelegramUrl?: string;
};

type AppState =
  | { kind: "loading"; message: string }
  | { kind: "invalid-token" }
  | { kind: "ready"; bootstrap: BootstrapResponse }
  | { kind: "detector-error"; message: string; state?: string }
  | { kind: "complete"; returnToTelegramUrl?: string };

const returnToTelegramFallbackUrl = "https://t.me/trempiadabot";

function getTokenFromQuery(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");

  if (!token) {
    return null;
  }

  const trimmedToken = token.trim();
  return trimmedToken.length > 0 ? trimmedToken : null;
}

function shouldUseMockDetector(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("mock") === "1" || import.meta.env.VITE_LIVENESS_MOCK === "1";
}

function toAwsCredentials(credentials: BootstrapCredentials): AwsCredentials {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
    expiration: credentials.expiration ? new Date(credentials.expiration) : undefined,
  };
}

async function bootstrapLiveness(token: string): Promise<BootstrapResponse> {
  const bootstrapUrl =
    import.meta.env.VITE_LIVENESS_BOOTSTRAP_URL ??
    (window as Window & { __LIVENESS_BOOTSTRAP_URL__?: string }).__LIVENESS_BOOTSTRAP_URL__;

  if (!bootstrapUrl) {
    throw new Error("Missing VITE_LIVENESS_BOOTSTRAP_URL");
  }

  const response = await fetch(bootstrapUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    throw new Error(`Bootstrap failed with ${response.status}`);
  }

  const payload = (await response.json()) as Partial<
    Omit<BootstrapResponse, "credentials"> & { credentials: BootstrapCredentials }
  >;

  if (
    !payload.sessionId ||
    !payload.region ||
    !payload.credentials?.accessKeyId ||
    !payload.credentials?.secretAccessKey ||
    !payload.credentials?.sessionToken
  ) {
    throw new Error("Bootstrap response is missing required fields");
  }

  return {
    sessionId: payload.sessionId,
    region: payload.region,
    credentials: toAwsCredentials(payload.credentials),
    returnToTelegramUrl: payload.returnToTelegramUrl,
  };
}

function closeTelegramWebApp(): boolean {
  const telegram = (
    window as Window & {
      Telegram?: { WebApp?: { close?: () => void } };
    }
  ).Telegram;

  if (telegram?.WebApp?.close) {
    telegram.WebApp.close();
    return true;
  }

  return false;
}

function App() {
  const bootstrapStartedRef = useRef(false);
  const token = useMemo(getTokenFromQuery, []);
  const useMockDetector = useMemo(shouldUseMockDetector, []);
  const [hasStartedCheck, setHasStartedCheck] = useState(false);
  const [state, setState] = useState<AppState>(() =>
    useMockDetector
      ? {
          kind: "ready",
          bootstrap: {
            sessionId: "mock-session",
            region: "eu-west-1",
            credentials: {
              accessKeyId: "mock-access-key",
              secretAccessKey: "mock-secret",
              sessionToken: "mock-session-token",
            },
            returnToTelegramUrl: returnToTelegramFallbackUrl,
          },
        }
      : token
        ? { kind: "loading", message: "Preparing camera check..." }
        : { kind: "invalid-token" },
  );

  useEffect(() => {
    if (useMockDetector || !token || bootstrapStartedRef.current) {
      return;
    }

    bootstrapStartedRef.current = true;

    void bootstrapLiveness(token)
      .then((bootstrap) => {
        setState({ kind: "ready", bootstrap });
      })
      .catch((error: unknown) => {
        const message =
          error instanceof Error ? error.message : "The liveness session could not be prepared.";
        setState({ kind: "detector-error", message, state: "BOOTSTRAP_ERROR" });
      });
  }, [token, useMockDetector]);

  if (state.kind === "loading") {
    return (
      <StatusScreen title={state.message} detail="Contacting the verification service." busy />
    );
  }

  if (state.kind === "invalid-token") {
    return (
      <StatusScreen
        title="Invalid verification link"
        detail="Open the link from Telegram again. This page only accepts a valid token in the URL."
      />
    );
  }

  if (state.kind === "detector-error") {
    return (
      <LivenessErrorScreen
        error={{ state: state.state, message: state.message }}
        onRetryHere={() => {
          window.location.reload();
        }}
        onReturnToTelegram={() => {
          if (closeTelegramWebApp()) {
            return;
          }

          window.location.assign(returnToTelegramFallbackUrl);
        }}
      />
    );
  }

  if (state.kind === "complete") {
    return (
      <StatusScreen
        title="Verification submitted"
        detail="You can return to Telegram while the result is processed."
        actionLabel="Return to Telegram"
        onAction={() => {
          if (closeTelegramWebApp()) {
            return;
          }

          if (state.returnToTelegramUrl) {
            window.location.assign(state.returnToTelegramUrl);
            return;
          }

          window.close();
        }}
      />
    );
  }

  const credentialProvider: AwsCredentialProvider = async () => state.bootstrap.credentials;
  const startCheck = () => {
    clearStoredLivenessCameraId();
    setHasStartedCheck(true);
  };
  const returnToTelegram = () => {
    if (closeTelegramWebApp()) {
      return;
    }

    window.location.assign(returnToTelegramFallbackUrl);
  };

  if (state.kind === "ready" && !hasStartedCheck) {
    return <LivenessIntroScreen onStart={startCheck} onReturnToTelegram={returnToTelegram} />;
  }

  return (
    <div className="app-shell detector-shell detector-shell--fullscreen">
      <div className="detector-card">
        {useMockDetector ? (
          <MockDetector
            onComplete={() => {
              setState({
                kind: "complete",
                returnToTelegramUrl: state.bootstrap.returnToTelegramUrl,
              });
            }}
            onError={(message) => {
              setState({ kind: "detector-error", message });
            }}
          />
        ) : (
          <FaceLivenessDetectorCore
            sessionId={state.bootstrap.sessionId}
            region={state.bootstrap.region}
            config={{
              credentialProvider,
            }}
            displayText={{
              hintCenterFaceText: "Center your face",
              hintMoveFaceFrontOfCameraText: "Move into better light and face the camera directly",
              hintCanNotIdentifyText:
                "We can't see your whole face clearly enough yet. Remove anything covering it and try again.",
              recordingIndicatorText: "Verifying...",
              cancelLivenessCheckText: "Cancel",
            }}
            disableStartScreen
            onAnalysisComplete={async () => {
              setState({
                kind: "complete",
                returnToTelegramUrl: state.bootstrap.returnToTelegramUrl,
              });
            }}
            onError={(error: any) => {
              const message = error.error?.message ?? error.state ?? "Face detector failed.";
              setState({ kind: "detector-error", message, state: error.state });
            }}
          />
        )}
      </div>
    </div>
  );
}

type StatusScreenProps = {
  title: string;
  detail: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
};

function StatusScreen({ title, detail, busy = false, actionLabel, onAction }: StatusScreenProps) {
  return (
    <main className="app-shell">
      <section className="status-card">
        <p className="eyebrow">Trempiada</p>
        <h1>{title}</h1>
        <p className="status-detail">{detail}</p>
        {busy ? <Loader size="large" /> : null}
        {actionLabel && onAction ? (
          <button className="primary-button" type="button" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </section>
    </main>
  );
}

export default App;
