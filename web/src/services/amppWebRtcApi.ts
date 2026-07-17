const WEBRTC_DEBUG = import.meta.env.VITE_WEBRTC_DEBUG === 'true';

function debugLog(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.log(...args);
  }
}

export type WebRtcSessionDetails = {
  workloadId: string;
  engineInstanceId: string;
  tunnelId: string;
  receiverTopic: string;
  discoveryTopic: string;
  senderTopic: string;
  statsTopic: string;
};

export type WebRtcNotification = {
  account?: string;
  time?: string;
  topic: string;
  content: unknown;
  source?: string;
  correlationId?: string;
  ttl?: number;
};

export async function startWebRtcSession(
  workloadId: string,
  engineInstanceId: string,
): Promise<WebRtcSessionDetails> {
  debugLog('[VNR WebRTC API] POST /api/ampp/control/webrtc/session', {
    workloadId,
    engineInstanceId,
  });

  const response = await fetch('/api/ampp/control/webrtc/session', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ workloadId, engineInstanceId }),
  });

  debugLog('[VNR WebRTC API] session response status', {
    ok: response.ok,
    status: response.status,
  });

  if (!response.ok) {
    throw new Error(`Start WebRTC session failed: ${response.status}`);
  }

  const json = await response.json();

  debugLog('[VNR WebRTC API] session response body', json);

  return json;
}

export async function sendWebRtcSignal(input: {
  workloadId: string;
  engineInstanceId: string;
  topic: string;
  content: unknown;
}) {
  debugLog('[VNR WebRTC API] POST /api/ampp/control/webrtc/signal', {
    workloadId: input.workloadId,
    engineInstanceId: input.engineInstanceId,
    topic: input.topic,
    contentSummary: summarizeWebRtcSignalContent(input.content),
  });

  const response = await fetch('/api/ampp/control/webrtc/signal', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  debugLog('[VNR WebRTC API] signal response status', {
    ok: response.ok,
    status: response.status,
    topic: input.topic,
  });

  if (!response.ok) {
    throw new Error(`Send WebRTC signal failed: ${response.status}`);
  }

  const json = await response.json();

  debugLog('[VNR WebRTC API] signal response body', json);

  return json;
}

function summarizeWebRtcSignalContent(content: unknown) {
  if (!content || typeof content !== 'object') {
    return { valueType: typeof content };
  }

  const signalContent = content as {
    type?: string;
    sdpType?: string;
    tunnelId?: string;
    receiverTopic?: string;
    sdp?: string;
    fullSdp?: string;
    candidate?: string | object;
    iceCandidate?: object;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  };

  return {
    type: signalContent.type,
    sdpType: signalContent.sdpType,
    tunnelId: signalContent.tunnelId,
    receiverTopic: signalContent.receiverTopic,
    hasSdp: Boolean(signalContent.sdp || signalContent.fullSdp),
    sdpLength: signalContent.sdp?.length ?? signalContent.fullSdp?.length ?? 0,
    hasCandidate: Boolean(signalContent.candidate || signalContent.iceCandidate),
    candidateType: typeof signalContent.candidate,
    sdpMid: signalContent.sdpMid,
    sdpMLineIndex: signalContent.sdpMLineIndex,
  };
}
