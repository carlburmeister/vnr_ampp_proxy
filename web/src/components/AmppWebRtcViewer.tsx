import { useEffect, useRef, useState } from 'react';

import {
  sendWebRtcSignal,
  startWebRtcSession,
  type WebRtcNotification,
  type WebRtcSessionDetails,
} from '../services/amppWebRtcApi';

type AmppWebRtcViewerProps = {
  workloadId: string;
  engineInstanceId: string;
  title: string;
  onClose: () => void;
};

type SignalSender = {
  id?: string;
  senderId?: string;
  sdp?: string;
  fullSdp?: string;
  description?: RTCSessionDescriptionInit;
  iceServers?: RTCIceServer[];
  sender?: {
    id?: string;
  };
};

type SignalContent = {
  type?: string;
  sdpType?: RTCSdpType;
  tunnelId?: string;
  sdp?: string;
  fullSdp?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: string | RTCIceCandidateInit;
  iceCandidate?: RTCIceCandidateInit;
  streamId?: number;
  mLineIndex?: number;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  iceServers?: RTCIceServer[];
  tunnelConfig?: {
    iceServers?: RTCIceServer[];
  };
  receiverTopic?: string;
  keepAliveFrequencySeconds?: number;
  senderId?: string;
  id?: string;
  sender?: {
    id?: string;
  };
  senders?: SignalSender[];
  results?: SignalSender[];
};

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun4.l.google.com:19302' },
];

const WEBRTC_DEBUG = import.meta.env.VITE_WEBRTC_DEBUG === 'true';
const WEBRTC_ICE_FAILURE_MESSAGE = 'WebRTC media connection failed. VPN/firewall may be blocking WebRTC media.';

/*
  Set VITE_WEBRTC_DEBUG=true in web/.env.local
  Or run with: VITE_WEBRTC_DEBUG=true npm run dev
  NOTE: Backend Nest server logging flag is in api/.env: WEBRTC_DEBUG=true
*/
function debugLog(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.log(...args);
  }
}

function debugWarn(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.warn(...args);
  }
}

function debugError(...args: unknown[]) {
  if (WEBRTC_DEBUG) {
    console.error(...args);
  }
}

export function AmppWebRtcViewer({
  workloadId,
  engineInstanceId,
  title,
  onClose,
}: AmppWebRtcViewerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionRef = useRef<WebRtcSessionDetails | null>(null);
  const senderTopicRef = useRef('');
  const activeTunnelIdRef = useRef('');
  const initSentRef = useRef(false);
  const queuedRemoteIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const [status, setStatus] = useState('Starting WebRTC session...');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const startupTimer = window.setTimeout(() => {
      void start();
    }, 0);

    async function start() {
      try {
        debugLog('[VNR WebRTC] viewer mounted; starting session', {
          workloadId,
          engineInstanceId,
          title,
        });

        const session = await startWebRtcSession(workloadId, engineInstanceId);

        if (cancelled) {
          return;
        }

        sessionRef.current = session;
        senderTopicRef.current = session.senderTopic;
        activeTunnelIdRef.current = session.tunnelId;

        debugLog('[VNR WebRTC] session created', session);

        setStatus(`Subscribed to ${session.receiverTopic}`);

        const source = new EventSource('/api/ampp/control/webrtc/stream', {
          withCredentials: true,
        });

        eventSourceRef.current = source;

        debugLog('[VNR WebRTC] opening SSE signaling stream', {
          streamUrl: '/api/ampp/control/webrtc/stream',
          receiverTopic: session.receiverTopic,
          statsTopic: session.statsTopic,
        });

        source.onopen = async () => {
          if (cancelled || !sessionRef.current) {
            return;
          }

          debugLog('[VNR WebRTC] SSE stream opened; sending discovery', {
            discoveryTopic: session.discoveryTopic,
            receiverTopic: session.receiverTopic,
            tunnelId: session.tunnelId,
          });

          setStatus('Sending WebRTC discovery...');
          await publishSignal(session.discoveryTopic, {
            type: 'discovery',
            receiverTopic: session.receiverTopic,
          });
        };

        source.onmessage = async (event) => {
          if (cancelled || !sessionRef.current) {
            return;
          }

          const notification = JSON.parse(event.data) as WebRtcNotification;

          debugLog('[VNR WebRTC] SSE notification received', {
            topic: notification.topic,
            expectedReceiverTopic: sessionRef.current.receiverTopic,
            expectedStatsTopic: sessionRef.current.statsTopic,
            contentSummary: summarizeSignalContent(notification.content),
          });

          if (
            notification.topic !== sessionRef.current.receiverTopic &&
            notification.topic !== sessionRef.current.statsTopic
          ) {
            debugLog('[VNR WebRTC] ignoring SSE notification for unrelated topic', {
              topic: notification.topic,
            });
            return;
          }

          const content = parseSignalContent(notification.content);
          await handleSignalContent(content);
        };

        source.onerror = (event) => {
          if (!cancelled) {
            debugError('[VNR WebRTC] SSE signaling stream error/reconnect', event);
            setStatus('WebRTC signaling stream reconnecting...');
          }
        };
      } catch (err) {
        if (!cancelled) {
          debugError('[VNR WebRTC] viewer start failed', err);
          setError(err instanceof Error ? err.message : 'Unknown WebRTC error');
          setStatus('WebRTC start failed');
        }
      }
    }

    async function publishSignal(topic: string, content: unknown) {
      debugLog('[VNR WebRTC] publishing signal', {
        topic,
        contentSummary: summarizeSignalContent(content),
      });

      await sendWebRtcSignal({
        workloadId,
        engineInstanceId,
        topic,
        content,
      });
    }

    async function handleSignalContent(content: SignalContent) {
      const session = sessionRef.current;

      if (!session) {
        return;
      }

      if (isDiscoveryResult(content)) {
        const senderId = findSenderId(content);
        const senderSdp = getDiscoverySenderSdp(content);

        debugLog('[VNR WebRTC] discovery result received; waiting for Mocha SDP offer', {
          senderId,
          hasSenderSdp: Boolean(senderSdp),
          senderSdpLength: senderSdp.length,
          contentSummary: summarizeSignalContent(content),
        });

        if (senderId) {
          senderTopicRef.current = `gv.engine.${engineInstanceId}.senders.${senderId}`;

          debugLog('[VNR WebRTC] sender topic updated from discovery result', {
            senderTopic: senderTopicRef.current,
          });

          if (!initSentRef.current) {
            initSentRef.current = true;

            debugLog('[VNR WebRTC] sending Mocha tunnel init message', {
              senderTopic: senderTopicRef.current,
              receiverTopic: session.receiverTopic,
              tunnelId: session.tunnelId,
              keepAliveFrequencySeconds: 21600,
            });

            setStatus('Sender discovered; initializing WebRTC tunnel...');

            await publishSignal(senderTopicRef.current, {
              type: 'init',
              receiverTopic: session.receiverTopic,
              tunnelId: session.tunnelId,
              keepAliveFrequencySeconds: 21600,
            });
          }
        }

        setStatus('WebRTC tunnel initialized; waiting for Mocha offer...');
        return;
      }

      if (isOffer(content)) {
        const sdp = getSdp(content);
        const iceServers = getOfferIceServers(content);

        if (content.tunnelId) {
          activeTunnelIdRef.current = content.tunnelId;
        }

        debugLog('[VNR WebRTC] SDP offer received from Mocha', {
          tunnelId: content.tunnelId,
          sdpLength: sdp.length,
          iceServerCount: iceServers.length,
          hasTunnelConfig: Boolean(content.tunnelConfig),
        });

        if (!sdp) {
          debugError('[VNR WebRTC] offer missing SDP', {
            contentSummary: summarizeSignalContent(content),
          });
          throw new Error('WebRTC offer did not include SDP');
        }

        const peerConnection = createPeerConnection(iceServers);

        setStatus('Received offer; creating answer...');
        await peerConnection.setRemoteDescription({ type: 'offer', sdp });

        debugLog('[VNR WebRTC] remote description set from Mocha offer', {
          signalingState: peerConnection.signalingState,
        });

        const answer = await peerConnection.createAnswer();

        debugLog('[VNR WebRTC] local SDP answer created', {
          sdpLength: answer.sdp?.length ?? 0,
        });

        await peerConnection.setLocalDescription(answer);

        debugLog('[VNR WebRTC] local description set; sending answer', {
          signalingState: peerConnection.signalingState,
          senderTopic: senderTopicRef.current,
          tunnelId: activeTunnelIdRef.current || session.tunnelId,
        });

        await publishSignal(senderTopicRef.current, {
          type: 'newFullSdp',
          sdpType: 'answer',
          tunnelId: activeTunnelIdRef.current || session.tunnelId,
          sdp: answer.sdp,
        });

        await addQueuedRemoteIceCandidates(peerConnection);
        setStatus('WebRTC answer sent; connecting media...');
        return;
      }

      if (isAnswer(content)) {
        debugLog('[VNR WebRTC] ignoring unexpected SDP answer because AMPP/Mocha should be the offerer', {
          tunnelId: content.tunnelId,
          contentSummary: summarizeSignalContent(content),
        });
        return;
      }

      if (isIceCandidate(content)) {
        const peerConnection = peerConnectionRef.current;

        debugLog('[VNR WebRTC] remote ICE candidate received', {
          hasPeerConnection: Boolean(peerConnection),
          hasRemoteDescription: Boolean(peerConnection?.remoteDescription),
          contentSummary: summarizeSignalContent(content),
        });

        if (!peerConnection) {
          debugWarn('[VNR WebRTC] ignoring remote ICE candidate before peer connection exists');
          return;
        }

        const candidate = getIceCandidate(content);

        if (!candidate) {
          debugWarn('[VNR WebRTC] remote ICE candidate message did not include a parseable candidate', {
            contentSummary: summarizeSignalContent(content),
          });
          return;
        }

        if (!peerConnection.remoteDescription) {
          queuedRemoteIceCandidatesRef.current.push(candidate);

          debugLog('[VNR WebRTC] queued remote ICE candidate until remote description is set', {
            queuedRemoteIceCandidateCount: queuedRemoteIceCandidatesRef.current.length,
          });
          return;
        }

        await peerConnection.addIceCandidate(candidate);

        debugLog('[VNR WebRTC] remote ICE candidate added', {
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }
    }

    function createPeerConnection(iceServers: RTCIceServer[]) {
      if (peerConnectionRef.current) {
        return peerConnectionRef.current;
      }

      debugLog('[VNR WebRTC] creating RTCPeerConnection', {
        iceServers,
      });

      const peerConnection = new RTCPeerConnection({ iceServers });

      peerConnection.onicecandidate = async (event) => {
        const session = sessionRef.current;

        if (!event.candidate || !session) {
          debugLog('[VNR WebRTC] local ICE gathering complete or session missing', {
            hasCandidate: Boolean(event.candidate),
            hasSession: Boolean(session),
          });
          return;
        }

        debugLog('[VNR WebRTC] local ICE candidate generated', {
          candidateType: event.candidate.type,
          protocol: event.candidate.protocol,
          address: event.candidate.address,
          port: event.candidate.port,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          senderTopic: senderTopicRef.current,
        });

        await publishSignal(senderTopicRef.current, {
          type: 'newCandidateSdp',
          tunnelId: activeTunnelIdRef.current || session.tunnelId,
          streamId: event.candidate.sdpMLineIndex ?? 0,
          mLineIndex: event.candidate.sdpMLineIndex ?? 0,
          sdp: event.candidate.candidate,
        });
      };

      peerConnection.ontrack = (event) => {
        debugLog('[VNR WebRTC] remote media track received', {
          trackKind: event.track.kind,
          trackId: event.track.id,
          streamCount: event.streams.length,
          streamIds: event.streams.map((stream) => stream.id),
        });

        if (videoRef.current && videoRef.current.srcObject !== event.streams[0]) {
          videoRef.current.srcObject = event.streams[0];
        }
      };

      peerConnection.onconnectionstatechange = () => {
        debugLog('[VNR WebRTC] connection state changed', {
          connectionState: peerConnection.connectionState,
          iceConnectionState: peerConnection.iceConnectionState,
          iceGatheringState: peerConnection.iceGatheringState,
          signalingState: peerConnection.signalingState,
        });

        if (peerConnection.connectionState === 'failed') {
          setError(WEBRTC_ICE_FAILURE_MESSAGE);
          setStatus('WebRTC media connection failed');
          return;
        }

        if (peerConnection.connectionState === 'connected') {
          setError('');
        }

        setStatus(`WebRTC connection state: ${peerConnection.connectionState}`);
      };

      peerConnection.oniceconnectionstatechange = () => {
        debugLog('[VNR WebRTC] ICE connection state changed', {
          iceConnectionState: peerConnection.iceConnectionState,
        });

        if (
          peerConnection.iceConnectionState === 'failed' ||
          peerConnection.iceConnectionState === 'disconnected'
        ) {
          setError(WEBRTC_ICE_FAILURE_MESSAGE);
          setStatus('WebRTC media connection interrupted');
          return;
        }

        if (
          peerConnection.iceConnectionState === 'connected' ||
          peerConnection.iceConnectionState === 'completed'
        ) {
          setError('');
        }
      };

      peerConnection.onicegatheringstatechange = () => {
        debugLog('[VNR WebRTC] ICE gathering state changed', {
          iceGatheringState: peerConnection.iceGatheringState,
        });
      };

      peerConnection.onsignalingstatechange = () => {
        debugLog('[VNR WebRTC] signaling state changed', {
          signalingState: peerConnection.signalingState,
        });
      };

      peerConnectionRef.current = peerConnection;
      return peerConnection;
    }

    async function addQueuedRemoteIceCandidates(peerConnection: RTCPeerConnection) {
      const queuedCandidates = queuedRemoteIceCandidatesRef.current.splice(0);

      if (queuedCandidates.length === 0) {
        return;
      }

      debugLog('[VNR WebRTC] adding queued remote ICE candidates', {
        queuedRemoteIceCandidateCount: queuedCandidates.length,
      });

      for (const candidate of queuedCandidates) {
        await peerConnection.addIceCandidate(candidate);
      }
    }

    return () => {
      debugLog('[VNR WebRTC] viewer unmounting; closing SSE and peer connection', {
        workloadId,
        engineInstanceId,
      });

      cancelled = true;
      window.clearTimeout(startupTimer);
      eventSourceRef.current?.close();
      peerConnectionRef.current?.close();
      eventSourceRef.current = null;
      peerConnectionRef.current = null;
      sessionRef.current = null;
      senderTopicRef.current = '';
      activeTunnelIdRef.current = '';
      initSentRef.current = false;
      queuedRemoteIceCandidatesRef.current = [];
    };
  }, [engineInstanceId, workloadId]);

  return (
    <section className="ampp-webrtc-viewer">
      <header className="ampp-webrtc-viewer-header">
        <div>
          <h2>{title}</h2>
          <p>{status}</p>
          {error && <p className="ampp-webrtc-error">{error}</p>}
        </div>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>

      <video
        ref={videoRef}
        className="ampp-webrtc-video"
        autoPlay
        playsInline
        controls
      />
    </section>
  );
}

function summarizeSignalContent(content: unknown) {
  if (!content || typeof content !== 'object') {
    return { valueType: typeof content };
  }

  const signalContent = content as SignalContent & { receiverTopic?: string };
  const senderSdp = getDiscoverySenderSdp(signalContent);
  const candidateSdp = getCandidateSdp(signalContent);

  return {
    type: signalContent.type,
    sdpType: signalContent.sdpType,
    tunnelId: signalContent.tunnelId,
    receiverTopic: signalContent.receiverTopic,
    keepAliveFrequencySeconds: signalContent.keepAliveFrequencySeconds,
    senderId: findSenderId(signalContent),
    hasSdp: Boolean(signalContent.sdp || signalContent.fullSdp || signalContent.description?.sdp),
    sdpLength: signalContent.sdp?.length ?? signalContent.fullSdp?.length ?? signalContent.description?.sdp?.length ?? 0,
    hasSenderSdp: Boolean(senderSdp),
    senderSdpLength: senderSdp.length,
    hasCandidate: Boolean(signalContent.candidate || signalContent.iceCandidate || candidateSdp),
    candidateSdpLength: candidateSdp.length,
    iceServerCount: signalContent.iceServers?.length ?? 0,
    tunnelConfigIceServerCount: signalContent.tunnelConfig?.iceServers?.length ?? 0,
    sendersCount: signalContent.senders?.length ?? 0,
    resultsCount: signalContent.results?.length ?? 0,
  };
}

function parseSignalContent(content: unknown): SignalContent {
  if (typeof content === 'string') {
    try {
      return JSON.parse(content) as SignalContent;
    } catch {
      return {};
    }
  }

  if (content && typeof content === 'object') {
    return content as SignalContent;
  }

  return {};
}

function isDiscoveryResult(content: SignalContent) {
  return content.type === 'discoveryResults' ||
    Boolean(content.senders?.length) ||
    Boolean(content.results?.length);
}

function isOffer(content: SignalContent) {
  return content.type === 'newFullSdp' && content.sdpType === 'offer';
}

function isAnswer(content: SignalContent) {
  return content.type === 'newFullSdp' && content.sdpType === 'answer';
}

function isIceCandidate(content: SignalContent) {
  return content.type === 'newCandidateSdp' ||
    content.type === 'newIceCandidate' ||
    content.type === 'candidate' ||
    Boolean(content.candidate) ||
    Boolean(content.iceCandidate) ||
    Boolean(getCandidateSdp(content));
}

function getSdp(content: SignalContent | SignalSender) {
  return content.sdp ?? content.fullSdp ?? content.description?.sdp ?? '';
}

function getCandidateSdp(content: SignalContent) {
  if (content.type === 'newCandidateSdp' && typeof content.sdp === 'string') {
    return content.sdp;
  }

  if (typeof content.candidate === 'string') {
    return content.candidate;
  }

  return '';
}

function getIceCandidate(content: SignalContent): RTCIceCandidateInit | null {
  if (content.iceCandidate) {
    return content.iceCandidate;
  }

  const candidateSdp = getCandidateSdp(content);

  if (candidateSdp) {
    return {
      candidate: candidateSdp,
      sdpMid: content.sdpMid ?? undefined,
      sdpMLineIndex: content.mLineIndex ?? content.sdpMLineIndex ?? undefined,
    };
  }

  if (content.candidate && typeof content.candidate === 'object') {
    return content.candidate;
  }

  return null;
}

function findDiscoverySender(content: SignalContent) {
  return content.senders?.[0] ?? content.results?.[0] ?? null;
}

function getDiscoverySenderSdp(content: SignalContent) {
  const sender = findDiscoverySender(content);
  return sender ? getSdp(sender) : '';
}

function getOfferIceServers(content: SignalContent) {
  return content.tunnelConfig?.iceServers ?? content.iceServers ?? DEFAULT_ICE_SERVERS;
}

function findSenderId(content: SignalContent) {
  return content.senderId ??
    content.id ??
    content.sender?.id ??
    content.senders?.[0]?.senderId ??
    content.senders?.[0]?.id ??
    content.senders?.[0]?.sender?.id ??
    content.results?.[0]?.senderId ??
    content.results?.[0]?.id ??
    content.results?.[0]?.sender?.id ??
    '';
}
