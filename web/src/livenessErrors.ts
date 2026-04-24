export type LivenessErrorInfo = {
  state?: string;
  message?: string;
};

export type LivenessErrorContent = {
  title: string;
  detail: string;
  hint?: string;
  showOpenInBrowser?: boolean;
};

function isTelegramWebView(): boolean {
  const telegram = (
    window as Window & {
      Telegram?: { WebApp?: unknown };
    }
  ).Telegram;

  if (telegram?.WebApp) {
    return true;
  }

  return /Telegram/i.test(window.navigator.userAgent);
}

export function getLivenessErrorContent(error: LivenessErrorInfo): LivenessErrorContent {
  const inTelegram = isTelegramWebView();

  switch (error.state) {
    case "DEFAULT_CAMERA_NOT_FOUND_ERROR":
      return {
        title: "Front camera unavailable",
        detail: inTelegram
          ? "Telegram's in-app browser is not exposing a usable front camera right now, even though Telegram itself may have camera permission."
          : "This browser is not exposing a usable front camera for the liveness check.",
        hint: inTelegram
          ? "Close this page, start a new liveness check from Telegram, and if it happens again open the link in Chrome or Safari. Also make sure no other app is holding the camera."
          : "Close other apps that might be using the camera and retry in the latest Chrome or Safari.",
        showOpenInBrowser: inTelegram,
      };
    case "CAMERA_ACCESS_ERROR":
      return {
        title: "Camera access blocked",
        detail: "The liveness check could not access your front camera.",
        hint: "Allow camera access for this page, then retry. If camera permission already looks enabled in Telegram, reopen the check or use Chrome/Safari.",
        showOpenInBrowser: inTelegram,
      };
    case "MOBILE_LANDSCAPE_ERROR":
      return {
        title: "Rotate your phone upright",
        detail: "Face liveness only works in portrait mode.",
        hint: "Hold the phone vertically and keep it upright throughout the check.",
      };
    case "MULTIPLE_FACES_ERROR":
      return {
        title: "Only one face should be visible",
        detail: "The detector found more than one face in the camera frame.",
        hint: "Move to a private view and keep only your face inside the oval.",
      };
    case "FACE_DISTANCE_ERROR":
      return {
        title: "Move a little farther back",
        detail: "Your face is too close to the camera for the liveness check to start cleanly.",
        hint: "Hold the phone slightly farther away and keep your whole face inside the oval.",
      };
    case "FRESHNESS_TIMEOUT":
    case "TIMEOUT":
      return {
        title: "The check timed out",
        detail: "The liveness session ran out of time before the capture completed.",
        hint: "Use bright, even light, keep the phone steady, and start a fresh check from Telegram.",
      };
    case "CAMERA_FRAMERATE_ERROR":
      return {
        title: "Camera quality is too low",
        detail: "This camera does not meet the minimum frame-rate requirements for liveness.",
        hint: "Try the device's built-in front camera in the latest Chrome or Safari.",
      };
    case "CONNECTION_TIMEOUT":
    case "SERVER_ERROR":
      return {
        title: "The liveness service did not respond",
        detail:
          "The check could not complete because the connection dropped or the service timed out.",
        hint: "Retry on a stable connection, or start a fresh check from Telegram.",
      };
    default:
      return {
        title: "Verification could not continue",
        detail: error.message ?? "Face detector failed.",
        hint: "Return to Telegram and start a new liveness check.",
        showOpenInBrowser: inTelegram,
      };
  }
}
