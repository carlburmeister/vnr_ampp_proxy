import { useEffect, useMemo, useState } from 'react';

export type KeyframeMessage = {
  producerName?: string;
  imageUrl?: string;
  timestamp?: string;
};

export function useAmppKeyframes(producerName: string, enabled: boolean) {
  const [latestKeyframe, setLatestKeyframe] = useState<KeyframeMessage | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!enabled || !producerName.trim()) {
      return;
    }

    const source = new EventSource(
      `/api/ampp/keyframes/stream?producerName=${encodeURIComponent(producerName)}`,
      { withCredentials: true },
    );

    source.onopen = () => {
      setError('');
    };

    source.onmessage = (event) => {
      setError('');
      const payload = JSON.parse(event.data) as KeyframeMessage;
      setLatestKeyframe(payload);
    };

    source.onerror = () => {
      setError('AMPP keyframe stream disconnected. Retrying…');
    };

    return () => {
      source.close();
    };
  }, [enabled, producerName]);

  return useMemo(
    () => ({
      latestKeyframe,
      error,
    }),
    [error, latestKeyframe],
  );
}
