import { useMemo, useState } from 'react';
import {
  sendProgramControlState,
  type AmppWorkload,
  subscribeToWorkloadNotifications,
} from '../../services/amppControlApi';

import { useAmppNotifications } from '../../hooks/useAmppNotifications';
import { useAmppKeyframes } from '../../hooks/useAmppKeyframes';
import {
  getLatestKeyframeForProducer,
  subscribeToKeyframesProducer,
} from '../../services/amppKeyframesApi';


const PRODUCER_NAME = 'HPz6L:CKB Test Prod - Mini Mix X 8 Inputs HD - Program';

export function AmppControlPanel() {
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const [applicationName, setApplicationName] = useState('');
  const [applicationTypes, setApplicationTypes] = useState<string[]>([]);
  const [workloadId, setWorkloadId] = useState('');
  const [workloads, setWorkloads] = useState<string[]>([]);
  const [workloadNames, setWorkloadNames] = useState<AmppWorkload[]>([]);
  const [showNotifications, setShowNotifications] = useState(true);

  const [keyframeListenerEnabled, setKeyframeListenerEnabled] = useState(false);
  const [latestKeyframeImageUrl, setLatestKeyframeImageUrl] = useState('');
  const [latestKeyframeTimestamp, setLatestKeyframeTimestamp] = useState('');

  const { latestKeyframe, error: keyframeStreamError } = useAmppKeyframes(
    PRODUCER_NAME,
    keyframeListenerEnabled,
  );

  const displayedKeyframeUrl = useMemo(
    () => latestKeyframe?.imageUrl ?? latestKeyframeImageUrl,
    [latestKeyframe?.imageUrl, latestKeyframeImageUrl],
  );

  const displayedKeyframeTimestamp = useMemo(
    () => latestKeyframe?.timestamp ?? latestKeyframeTimestamp,
    [latestKeyframe?.timestamp, latestKeyframeTimestamp],
  );

  const { messages, error: notificationError } = useAmppNotifications();


  async function handleSubscribeToWorkloadNotifications() {
    try {
      setError('');
      setStatus('Subscribing to getstate notifications...');

      await subscribeToWorkloadNotifications(workloadId);

      setStatus('Subscribed to getstate notifications');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }

  async function handleSendControlState(index: number) {
    try {
      setError('');

      if (!workloadId.trim()) {
        throw new Error('workloadId is required');
      }

      if (!applicationName.trim()) {
        throw new Error('applicationName is required');
      }

      setStatus(`Sending controlstate for index ${index}...`);

      await sendProgramControlState(workloadId, applicationName, index);

      setStatus(`Sent controlstate for index ${index}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }

  async function handleStartKeyframeListener() {
    try {
      setError('');

      if (!PRODUCER_NAME.trim()) {
        throw new Error('KEYFRAME_PRODUCER_NAME is required');
      }

      setStatus('Starting keyframe listener...');
      await subscribeToKeyframesProducer(PRODUCER_NAME);
      setKeyframeListenerEnabled(true);
      setStatus('Keyframe listener started');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }

  function handleStopKeyframeListener() {
    setKeyframeListenerEnabled(false);
    setStatus('Keyframe listener stopped');
  }

  async function handleLoadLatestKeyframe() {
    try {
      setError('');

      if (!PRODUCER_NAME.trim()) {
        throw new Error('KEYFRAME_PRODUCER_NAME is required');
      }

      setStatus('Loading latest keyframe...');
      const result = await getLatestKeyframeForProducer(PRODUCER_NAME);
      setLatestKeyframeImageUrl(result.imageUrl);
      setLatestKeyframeTimestamp(result.timestamp ?? '');
      setStatus('Latest keyframe loaded');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }

  const controlButtonStyle = {
    backgroundColor: '#ff6b6b',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '0.5rem 1rem',
    cursor: 'pointer',
    marginRight: '0.5rem',
  } as const;

  return (
    <section>
      <h2>Mini Mixer</h2>

      {status && <p>{status}</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}
      {notificationError && <p style={{ color: 'red' }}>{notificationError}</p>}


      <div
        style={{
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1rem',
        }}
      >
        <div>
          <div style={{ marginBottom: '0.5rem' }}>
            <button style={controlButtonStyle} onClick={() => handleSendControlState(1)}>
              1
            </button>
            <button style={controlButtonStyle} onClick={() => handleSendControlState(2)}>
              2
            </button>
          </div>

          <div style={{ marginBottom: '0.5rem' }}>
            <p style={{ margin: '0 0 0.5rem 0' }}>
              Producer: <strong>{PRODUCER_NAME || '(not set)'}</strong>
            </p>
            <button onClick={handleStartKeyframeListener} disabled={!PRODUCER_NAME.trim()}>
              Start Keyframe Listener
            </button>
            <button
              onClick={handleStopKeyframeListener}
              disabled={!keyframeListenerEnabled}
              style={{ marginLeft: '0.5rem' }}
            >
              Stop Listener
            </button>
            <button
              onClick={handleLoadLatestKeyframe}
              disabled={!PRODUCER_NAME.trim()}
              style={{ marginLeft: '0.5rem' }}
            >
              Load Latest Keyframe
            </button>
          </div>

          {keyframeStreamError && <p style={{ color: 'red' }}>{keyframeStreamError}</p>}
        </div>

        <div style={{ minWidth: '320px' }}>
          <h3 style={{ marginTop: 0 }}>Latest Keyframe</h3>
          {displayedKeyframeUrl ? (
            <img
              src={displayedKeyframeUrl}
              alt="Latest keyframe"
              style={{ width: '100%', maxWidth: '420px', border: '1px solid #ddd' }}
            />
          ) : (
            <div
              style={{
                width: '320px',
                height: '180px',
                border: '1px dashed #aaa',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              No keyframe loaded
            </div>
          )}
          {displayedKeyframeTimestamp && (
            <p style={{ marginTop: '0.5rem' }}>Timestamp: {displayedKeyframeTimestamp}</p>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3>Notifications</h3>
        <button onClick={() => setShowNotifications((current) => !current)}>
          {showNotifications ? 'Hide' : 'Show'}
        </button>
      </div>
      {showNotifications && (
        <pre style={{ textAlign: 'left', whiteSpace: 'pre-wrap' }}>
          {JSON.stringify(messages.slice(0, 10), null, 2)}
        </pre>
      )}
    </section>
  );
}
