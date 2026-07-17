/* SSE/EventSource listener */

import { useEffect, useState } from 'react';

const HARD_ERROR_DELAY_MS = 15000;
const HARD_ERROR_THRESHOLD = 3;

/* NOTIFICATIONS SUBSCRIPTION */
export function useAmppNotifications() {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const source = new EventSource('/api/ampp/control/notifications/stream', {
      withCredentials: true,
    });
    let disconnectedSince: number | null = null;
    let consecutiveErrors = 0;

    const clearTransientError = () => {
      disconnectedSince = null;
      consecutiveErrors = 0;
      setError('');
    };

    source.onopen = () => {
      clearTransientError();
    };

    source.onmessage = (event) => {
      clearTransientError();
      const message = JSON.parse(event.data);
      setMessages((current) => [message, ...current]);
    };

    source.onerror = () => {
      consecutiveErrors += 1;

      if (disconnectedSince === null) {
        disconnectedSince = Date.now();
      }

      const disconnectedMs = Date.now() - disconnectedSince;
      const shouldShowHardError =
        consecutiveErrors >= HARD_ERROR_THRESHOLD &&
        disconnectedMs >= HARD_ERROR_DELAY_MS;

      if (shouldShowHardError) {
        setError('AMPP notification stream disconnected. Retrying…');
      }
    };

    return () => {
      source.close();
    };
  }, []);

  return {
    messages,
    error,
  };
}
