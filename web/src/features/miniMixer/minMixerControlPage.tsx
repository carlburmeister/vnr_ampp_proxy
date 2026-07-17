import { useEffect, useMemo, useState } from 'react';

import {
  getApplicationConfig,
  getApplicationState,
  getState,
  sendProgramPreviewControlState,
  sendKeyState,
  subscribeToWorkloadNotifications,
} from '../../services/amppControlApi';
import { MINI_MIXER_APPLICATION_NAME } from './minMixerConstants';

const CONTROL_BUTTON_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8];
const DARK_RED_BUTTON_COLOR = '#7f1d1d';
const DARK_GREEN_BUTTON_COLOR = '#14532d';
const BRIGHT_RED_BUTTON_COLOR = '#d92d20';
const BRIGHT_GREEN_BUTTON_COLOR = '#039855';
const DISABLED_BUTTON_COLOR = '#98a2b3';

type ControlButtonState = {
  Index: number;
  Program: boolean;
  Preview: boolean;
  isActive: boolean;
};

type AmppNotificationMessage = {
  type?: string;
  data?: {
    topic?: string;
    payload?: unknown;
    content?: unknown;
  };
};

type ControlStateNotificationPayload = {
  Index?: number;
  Program?: boolean;
  Preview?: boolean;
};

type KeyState = {
  transitionType: 'Cut' | 'Mix';
  active: boolean;
};

type MiniMixerStateNotificationContent = {
  keyOn?: boolean;
};

const createDefaultControlState = (): ControlButtonState[] =>
  CONTROL_BUTTON_INDEXES.map((Index) => ({
    Index,
    Program: false,
    Preview: false,
    isActive: false,
  }));

const createDefaultKeyState = (): KeyState[] => [
  { transitionType: 'Cut', active: false },
  { transitionType: 'Mix', active: false },
];

type MiniMixerInput = {
  alias?: string | null;
  isKey?: boolean;
  name?: string | null;
};

type MiniMixerConfig = {
  inputs?: MiniMixerInput[];
};


function parseNotificationContent(content: unknown) {
  if (typeof content !== 'string') {
    return content;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

const EMPTY_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const EMPTY_INPUT: MiniMixerInput = {};

export function MiniMixerControlPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const workloadId = params.get('workloadId') ?? '';
  const applicationName = params.get('applicationName') ?? MINI_MIXER_APPLICATION_NAME;
  const title = params.get('title') ?? 'Mini Mixer';

  const [status, setStatus] = useState('Loading Mini Mixer...');
  const [error, setError] = useState('');
  const [inputs, setInputs] = useState<MiniMixerInput[]>([]);
  const [current_controlstate, setCurrentControlstate] = useState<ControlButtonState[]>(
    createDefaultControlState,
  );
  const [current_keystate, setCurrentKeystate] = useState<KeyState[]>(createDefaultKeyState);

  useEffect(() => {
    let cancelled = false;

    async function initializeMiniMixer() {
      try {
        setError('');
        setStatus('Loading Mini Mixer configuration...');

        if (!workloadId.trim()) {
          throw new Error('workloadId is required');
        }

        const config = await getApplicationConfig(workloadId) as MiniMixerConfig;

        if (!cancelled) {
          const nextInputs = Array.isArray(config.inputs) ? config.inputs : [];
          const nextControlState = createDefaultControlState();

          nextInputs.slice(0, CONTROL_BUTTON_INDEXES.length).forEach((input, inputIndex) => {
            if (!input.isKey && input.name) {
              nextControlState[inputIndex] = {
                ...nextControlState[inputIndex],
                isActive: true,
              };
            }
          });

          setInputs(nextInputs);
          setCurrentControlstate(nextControlState);
        }

        setStatus('Subscribing to workload notifications...');
        await subscribeToWorkloadNotifications(workloadId);

        setStatus('Requesting Mini Mixer application state...');
        await getApplicationState(workloadId);

        setStatus('Requesting Mini Mixer control state...');
        await getState(workloadId);

        if (!cancelled) {
          setStatus('Mini Mixer ready');
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setStatus('');
        }
      }
    }

    void initializeMiniMixer();

    return () => {
      cancelled = true;
    };
  }, [workloadId]);

  useEffect(() => {
    if (!workloadId.trim()) {
      return undefined;
    }

    const controlStateNotifyTopic = `gv.ampp.control.${workloadId}.controlstate.notify`;
    const miniMixerStateTopic = `gv.ampp.apps.minimixer.${workloadId}.state`;
    const source = new EventSource('/api/ampp/control/notifications/stream', {
      withCredentials: true,
    });

    source.onmessage = (event) => {
      const message = JSON.parse(event.data) as AmppNotificationMessage;

      if (message.type !== 'notify' && message.type !== 'raw-notification') {
        return;
      }

      const payload = message.data?.payload;

      if (message.data?.topic === miniMixerStateTopic) {
        const content = parseNotificationContent(message.data.content) as MiniMixerStateNotificationContent;

        if (typeof content?.keyOn !== 'boolean') {
          return;
        }

        setCurrentKeystate((previousKeyState) =>
          previousKeyState.map((keyState) => ({
            ...keyState,
            active: content.keyOn ?? false,
          })),
        );
        return;
      }

      if (message.data?.topic !== controlStateNotifyTopic || !Array.isArray(payload)) {
        return;
      }

      setCurrentControlstate((previousControlState) =>
        previousControlState.map((controlState) => {
          if (!controlState.isActive) {
            return controlState;
          }

          const notificationState = payload.find(
            (item: ControlStateNotificationPayload) => item?.Index === controlState.Index,
          ) as ControlStateNotificationPayload | undefined;

          if (!notificationState) {
            return controlState;
          }

          return {
            ...controlState,
            Program: Boolean(notificationState.Program),
            Preview: Boolean(notificationState.Preview),
          };
        }),
      );
    };

    source.onerror = () => {
      setError('AMPP notification stream disconnected. Retrying…');
    };

    return () => {
      source.close();
    };
  }, [workloadId]);
  /*--------------------------------------------------------------------------*/
  //  ()
  /*--------------------------------------------------------------------------*/
  async function handleProgramControlClick(index: number) {
    try {
      setError('');
      if (!workloadId.trim()) {
        throw new Error('workloadId is required');
      }
      if (!applicationName.trim()) {
        throw new Error('applicationName is required');
      }

      const controlState = current_controlstate.find((state) => state.Index === index);

      if (controlState?.Program) {
        return;
      }

      setStatus(`Sending Program control state for input ${index}...`);
      
      await sendProgramPreviewControlState(workloadId, applicationName, index, true, false);
      
      setCurrentControlstate((previousControlState) =>
        previousControlState.map((controlState) =>
          controlState.Index === index
            ? { ...controlState, Program: true }
            : controlState,
        ),
      );
      setStatus(`Sent Program control state for input ${index}`);
    
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }
  /*--------------------------------------------------------------------------*/
  //  ()
  /*--------------------------------------------------------------------------*/
  async function handlePreviewControlClick(index: number) {
    try {
      setError('');
      if (!workloadId.trim()) {
        throw new Error('workloadId is required');
      }
      if (!applicationName.trim()) {
        throw new Error('applicationName is required');
      }

      const controlState = current_controlstate.find((state) => state.Index === index);

      if (controlState?.Preview) {
        return;
      }

      setStatus(`Sending Preview control state for input ${index}...`);
      
      await sendProgramPreviewControlState(workloadId, applicationName, index, false, true);
      
      setCurrentControlstate((previousControlState) =>
        previousControlState.map((controlState) =>
          controlState.Index === index
            ? { ...controlState, Preview: true }
            : controlState,
        ),
      );
      setStatus(`Sent Preview control state for input ${index}`);
    
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }
  /*--------------------------------------------------------------------------*/
  //  ()
  /*--------------------------------------------------------------------------*/
  async function handleKeyClick(transitionType: KeyState['transitionType']) {
    try {
      setError('');
      if (!workloadId.trim()) {
        throw new Error('workloadId is required');
      }
      if (!applicationName.trim()) {
        throw new Error('applicationName is required');
      }

      const keyOn = current_keystate.some((state) => state.active);
      const active = !keyOn;

      setStatus(`Sending ${transitionType} Key state...`);
      
      await sendKeyState(workloadId, applicationName, transitionType, active);

      setCurrentKeystate((previousKeyState) =>
        previousKeyState.map((keyState) =>
          keyState.transitionType === transitionType
            ? { ...keyState, active }
            : keyState,
        ),
      );
      
      setStatus(`Sent ${transitionType} Key state`);
    
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setStatus('');
    }
  }

  const baseButtonStyle = {
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    padding: '0.75rem 1.25rem',
    cursor: 'pointer',
    fontWeight: 700,
    minWidth: '3.5rem',
    width: '3.5rem',
  } as const;

  const imageStyle = {
    width: '54px',
    height: '31px',
    border: '1px solid #d0d5dd',
    objectFit: 'cover',
  } as const;

  const textFieldStyle = {
    width: '54px',
    height: '1.5rem',
    boxSizing: 'border-box',
  } as const;

  const columnStyle = {
    display: 'grid',
    justifyItems: 'center',
    gap: '0.35rem',
  } as const;

  const controlInputs = CONTROL_BUTTON_INDEXES.map((index) => inputs[index - 1] ?? EMPTY_INPUT);
  const keyInput = inputs[8] ?? EMPTY_INPUT;
  const keyOn = current_keystate.some((state) => state.active);
  const keyButtonEnabled = Boolean(keyInput.isKey && keyInput.name);

  return (
    <section>
      <h1>{title}</h1>
      <p>Workload: {workloadId || '(missing workloadId)'}</p>

      {status && <p>{status}</p>}
      {error && <p style={{ color: 'red' }}>{error}</p>}

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'stretch' }}>
        <div style={{ border: '1px solid #000', padding: '0.5rem' }}>
          <div style={{ marginBottom: '0.35rem', fontWeight: 700 }}>Control</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, auto)', gap: '0.5rem' }}>
            {controlInputs.map((input, inputIndex) => {
              const index = inputIndex + 1;
              const controlState = current_controlstate[inputIndex];
              const isEnabled = Boolean(controlState?.isActive);
              const alias = isEnabled ? input.alias ?? '' : '';
              const buttonStateStyle = {
                cursor: isEnabled ? 'pointer' : 'not-allowed',
                opacity: isEnabled ? 1 : 0.55,
              } as const;

              return (
                <div key={`control-${index}`} style={columnStyle}>
                  <img alt="" src={EMPTY_IMAGE_SRC} style={imageStyle} />
                  <input aria-label={`Control ${index} alias`} readOnly value={alias} style={textFieldStyle} />
                  <button
                    type="button"
                    style={{
                      ...baseButtonStyle,
                      ...buttonStateStyle,
                      backgroundColor: isEnabled
                        ? controlState.Program
                          ? BRIGHT_RED_BUTTON_COLOR
                          : DARK_RED_BUTTON_COLOR
                        : DISABLED_BUTTON_COLOR,
                    }}
                    onClick={() => handleProgramControlClick(index)}
                    disabled={!isEnabled}
                  >
                    {index}
                  </button>
                  <button
                    type="button"
                    style={{
                      ...baseButtonStyle,
                      ...buttonStateStyle,
                      backgroundColor: isEnabled
                        ? controlState.Preview
                          ? BRIGHT_GREEN_BUTTON_COLOR
                          : DARK_GREEN_BUTTON_COLOR
                        : DISABLED_BUTTON_COLOR,
                    }}
                    onClick={() => handlePreviewControlClick(index)}
                    disabled={!isEnabled}
                  >
                    {index}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ border: '1px solid #000', padding: '0.5rem' }}>
          <div style={{ marginBottom: '0.35rem', fontWeight: 700 }}>Key</div>
          <div style={columnStyle}>
            <img alt="" src={EMPTY_IMAGE_SRC} style={imageStyle} />
            <input
              aria-label="Key alias"
              readOnly
              value={keyInput.isKey ? keyInput.alias ?? '' : ''}
              style={textFieldStyle}
            />
            <button
              type="button"
              style={{
                ...baseButtonStyle,
                backgroundColor: keyButtonEnabled
                  ? keyOn
                    ? BRIGHT_RED_BUTTON_COLOR
                    : DARK_RED_BUTTON_COLOR
                  : DISABLED_BUTTON_COLOR,
                cursor: keyButtonEnabled ? 'pointer' : 'not-allowed',
                opacity: keyButtonEnabled ? 1 : 0.55,
              }}
              onClick={() => handleKeyClick('Cut')}
              disabled={!keyButtonEnabled}
            >
              Cut
            </button>
            <button
              type="button"
              style={{
                ...baseButtonStyle,
                backgroundColor: keyButtonEnabled
                  ? keyOn
                    ? BRIGHT_RED_BUTTON_COLOR
                    : DARK_RED_BUTTON_COLOR
                  : DISABLED_BUTTON_COLOR,
                cursor: keyButtonEnabled ? 'pointer' : 'not-allowed',
                opacity: keyButtonEnabled ? 1 : 0.55,
              }}
              onClick={() => handleKeyClick('Mix')}
              disabled={!keyButtonEnabled}
            >
              Mix
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
