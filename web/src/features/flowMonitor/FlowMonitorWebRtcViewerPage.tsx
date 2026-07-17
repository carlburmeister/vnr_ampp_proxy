import { AmppWebRtcViewer } from '../../components/AmppWebRtcViewer';

export function FlowMonitorWebRtcViewerPage() {
  const params = new URLSearchParams(window.location.search);
  const workloadId = params.get('workloadId') ?? '';
  const engineInstanceId = params.get('engineInstanceId') ?? '';
  const title = params.get('title') ?? 'Flow Monitor WebRTC Viewer';

  if (!workloadId || !engineInstanceId) {
    return (
      <section>
        <h1>Flow Monitor WebRTC Viewer</h1>
        <p>Missing workloadId or engineInstanceId.</p>
      </section>
    );
  }

  return (
    <AmppWebRtcViewer
      workloadId={workloadId}
      engineInstanceId={engineInstanceId}
      title={title}
      onClose={() => window.close()}
    />
  );
}
