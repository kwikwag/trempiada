const AMPLIFY_LIVENESS_CAMERA_ID_KEY = "AmplifyLivenessCameraId";

export function clearStoredLivenessCameraId(storage: Pick<Storage, "removeItem"> = localStorage) {
  storage.removeItem(AMPLIFY_LIVENESS_CAMERA_ID_KEY);
}

export async function probePreferredCameraDeviceId(): Promise<string | undefined> {
  if (!navigator.mediaDevices?.getUserMedia) {
    return undefined;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "user" },
      width: { ideal: 720 },
      height: { ideal: 1280 },
    },
  });

  try {
    const [track] = stream.getVideoTracks();
    return track?.getSettings().deviceId;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
