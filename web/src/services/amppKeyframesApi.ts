export type LatestKeyframe = {
  producerName: string;
  imageUrl: string;
  timestamp?: string;
};

export async function subscribeToKeyframesProducer(producerName: string) {
  const response = await fetch(
    `/api/ampp/keyframes/producers/${encodeURIComponent(producerName)}/listener`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );

  if (!response.ok) {
    throw new Error(`Subscribe to keyframes producer failed: ${response.status}`);
  }

  return response.json();
}

export async function getLatestKeyframeForProducer(
  producerName: string,
): Promise<LatestKeyframe> {
  const response = await fetch(
    `/api/ampp/keyframes/producers/${encodeURIComponent(producerName)}/latest`,
    { credentials: 'include' },
  );

  if (!response.ok) {
    throw new Error(`Load latest keyframe failed: ${response.status}`);
  }

  return response.json();
}
